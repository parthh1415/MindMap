import type { Landmark, RawHand, TrackedHand, Vec2 } from "./types";
import {
  SMOOTHING_ALPHA,
  TRACK_MATCH_MAX_DISTANCE,
  PINCH_ENTER_THRESHOLD,
  PINCH_EXIT_THRESHOLD,
  ROLE_LOCK_HOLD_FRAMES,
} from "./tunables";

export function computeCentroid(landmarks: Landmark[]): Vec2 {
  let sx = 0, sy = 0;
  for (const p of landmarks) { sx += p.x; sy += p.y; }
  const n = landmarks.length || 1;
  return { x: sx / n, y: sy / n };
}

export function computePalmSpan(landmarks: Landmark[]): number {
  const w = landmarks[0]!;
  const m = landmarks[9]!;
  const dx = m.x - w.x, dy = m.y - w.y;
  return Math.hypot(dx, dy);
}

export function computePinchStrength(landmarks: Landmark[], palmSpan: number): number {
  const thumb = landmarks[4]!;
  const index = landmarks[8]!;
  const dx = thumb.x - index.x, dy = thumb.y - index.y;
  const dist = Math.hypot(dx, dy);
  return palmSpan > 0 ? dist / palmSpan : 1.0;
}

export function emaLandmarks(prev: Landmark[] | null, next: Landmark[]): Landmark[] {
  if (!prev) return next.map((p) => ({ ...p }));
  return next.map((p, i) => {
    const q = prev[i]!;
    return {
      x: q.x + (p.x - q.x) * SMOOTHING_ALPHA,
      y: q.y + (p.y - q.y) * SMOOTHING_ALPHA,
      z: q.z + (p.z - q.z) * SMOOTHING_ALPHA,
    };
  });
}

let nextTrackId = 1;

export function makeTrackId(): string {
  return `t${nextTrackId++}`;
}

/**
 * Match raw hands to existing tracks by nearest centroid (greedy, O(n*m)
 * fine for n,m ≤ 2). Returns updated tracked hands. Tracks unmatched for
 * one frame stay alive but increment framesSinceSeen — caller drops
 * them when framesSinceSeen > ROLE_LOCK_HOLD_FRAMES.
 */
export function matchTracks(
  prev: TrackedHand[],
  raw: RawHand[],
  imageWidth: number,
  imageHeight: number,
): TrackedHand[] {
  const norm = (v: Vec2): Vec2 => ({ x: v.x / imageWidth, y: v.y / imageHeight });
  const usedPrev = new Set<number>();
  const result: TrackedHand[] = [];

  // Top-2 by palm span (drop noise hands)
  const candidates = raw
    .map((h) => ({ h, span: computePalmSpan(h.keypoints) }))
    .sort((a, b) => b.span - a.span)
    .slice(0, 2);

  for (const { h } of candidates) {
    const c = computeCentroid(h.keypoints);
    const cn = norm(c);
    let bestIdx = -1, bestDist = TRACK_MATCH_MAX_DISTANCE;
    for (let i = 0; i < prev.length; i++) {
      if (usedPrev.has(i)) continue;
      const p = prev[i]!;
      const pn = norm(p.centroid);
      const d = Math.hypot(pn.x - cn.x, pn.y - cn.y);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    const palmSpan = computePalmSpan(h.keypoints);
    const smoothed = emaLandmarks(bestIdx >= 0 ? prev[bestIdx]!.smoothed : null, h.keypoints);
    const pinchStrength = computePinchStrength(smoothed, palmSpan);
    const wasPinched = bestIdx >= 0 ? prev[bestIdx]!.isPinched : false;
    const isPinched = wasPinched
      ? pinchStrength < PINCH_EXIT_THRESHOLD
      : pinchStrength < PINCH_ENTER_THRESHOLD;

    if (bestIdx >= 0) usedPrev.add(bestIdx);
    result.push({
      trackId: bestIdx >= 0 ? prev[bestIdx]!.trackId : makeTrackId(),
      role: bestIdx >= 0 ? prev[bestIdx]!.role : null,
      smoothed,
      centroid: c,
      palmSpan,
      pinchStrength,
      isPinched,
      framesSinceSeen: 0,
    });
  }

  // Carry forward unmatched tracks for ROLE_LOCK_HOLD_FRAMES frames
  for (let i = 0; i < prev.length; i++) {
    if (usedPrev.has(i)) continue;
    const p = prev[i]!;
    if (p.framesSinceSeen + 1 < ROLE_LOCK_HOLD_FRAMES) {
      result.push({ ...p, framesSinceSeen: p.framesSinceSeen + 1 });
    }
  }
  return result;
}

// Per-track role lock: once we assign control/pointer to a trackId,
// we keep that role for the lifetime of the track. We DO NOT vote
// across N frames anymore — that introduced ~100ms of "no role" UX
// where pinches did nothing. First-frame handedness wins, locked in
// for the rest of that hand's tracking lifetime.
const lockedRoles = new Map<string, "control" | "pointer">();

export function resolveRoles(
  tracks: TrackedHand[],
  rawByTrackId: Map<string, RawHand>,
): TrackedHand[] {
  return tracks.map((t) => {
    // Carry forward locked role for this trackId.
    const locked = lockedRoles.get(t.trackId);
    if (locked) return { ...t, role: locked };

    // Otherwise assign role from THIS frame's handedness — no voting.
    // MediaPipe assumes selfie/mirrored input. Our video IS displayed
    // mirrored via CSS scaleX(-1) but fed UNMIRRORED to MediaPipe
    // (flipHorizontal: false). MediaPipe's selfie assumption combined
    // with our unmirrored feed means MediaPipe's "Left" label =
    // user's actual LEFT hand from the user's POV. So:
    //   MediaPipe "Left"  → user's left hand  → control role  (rotate/zoom)
    //   MediaPipe "Right" → user's right hand → pointer role  (activate)
    // Per the friend's reference spec.
    const raw = rawByTrackId.get(t.trackId);
    if (!raw) return t;
    const role: "control" | "pointer" =
      raw.handedness === "Left" ? "control" : "pointer";
    lockedRoles.set(t.trackId, role);
    return { ...t, role };
  });
}

export function clearTrackingState(): void {
  lockedRoles.clear();
  nextTrackId = 1;
}

import {
  createDetector,
  SupportedModels,
  type HandDetector,
} from "@tensorflow-models/hand-pose-detection";
import * as tf from "@tensorflow/tfjs-core";
// Side-effect import: registers the WebGL backend in the tfjs engine.
// Even with runtime: "mediapipe" (which runs inference via its own wasm),
// hand-pose-detection's createDetector calls tf.ready() during setup —
// and tf.ready() throws "No backend found in registry" if NO tfjs
// backend has been registered. WebGL is the fastest universally-
// available choice for the small bootstrap-time tensors.
import "@tensorflow/tfjs-backend-webgl";

let detector: HandDetector | null = null;
let mediapipeScriptLoadPromise: Promise<void> | null = null;

/**
 * Inject /mediapipe/hands/hands.js as a <script> tag and resolve when it
 * has finished installing `window.Hands`. The IIFE registers itself via
 * `za("Hands", od)` (Closure Library) so we can detect completion by
 * polling for `window.Hands`.
 *
 * Memoized — only loads once per session.
 */
function loadMediaPipeHandsScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.Hands) return Promise.resolve();
  if (mediapipeScriptLoadPromise) return mediapipeScriptLoadPromise;

  mediapipeScriptLoadPromise = new Promise<void>((resolve, reject) => {
    const src = `${window.location.origin}/mediapipe/hands/hands.js`;
    // If a prior attempt already added the tag, don't add it again.
    const existing = document.querySelector(
      `script[data-mp-hands="1"]`,
    ) as HTMLScriptElement | null;
    if (existing) {
      const tick = () => {
        if (window.Hands) resolve();
        else setTimeout(tick, 30);
      };
      tick();
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.async = false;
    s.dataset.mpHands = "1";
    s.onload = () => {
      // hands.js synchronously installs window.Hands inside its IIFE,
      // so by the time onload fires the global is set. Sanity check.
      if (window.Hands) resolve();
      else
        reject(
          new Error(
            "/mediapipe/hands/hands.js loaded but did not set window.Hands",
          ),
        );
    };
    s.onerror = () =>
      reject(new Error(`Failed to load ${src} (404 or network error)`));
    document.head.appendChild(s);
  });
  return mediapipeScriptLoadPromise;
}

export async function initDetector(): Promise<HandDetector> {
  if (detector) return detector;
  // 1. Inject the @mediapipe/hands IIFE so the alias-stub's lazy Proxy
  //    can forward `new Hands(config)` to the real constructor.
  await loadMediaPipeHandsScript();
  // 2. Activate the WebGL backend. Without setBackend before tf.ready,
  //    'No backend found in registry' is thrown — even though mediapipe
  //    runtime runs inference via its own wasm, the tfjs engine still
  //    needs a backend for createDetector's setup-time tensors.
  await tf.setBackend("webgl");
  await tf.ready();
  // 3. mediapipe runtime — accurate, fast, all assets local.
  detector = await createDetector(SupportedModels.MediaPipeHands, {
    runtime: "mediapipe",
    modelType: "full",
    maxHands: 2,
    solutionPath: `${window.location.origin}/mediapipe/hands`,
  });
  return detector;
}

export async function disposeDetector(): Promise<void> {
  if (detector) {
    detector.dispose();
    detector = null;
  }
  clearTrackingState();
}
