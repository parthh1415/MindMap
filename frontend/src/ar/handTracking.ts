import type { Landmark, RawHand, TrackedHand, Vec2 } from "./types";
import {
  SMOOTHING_ALPHA,
  TRACK_MATCH_MAX_DISTANCE,
  PINCH_ENTER_THRESHOLD,
  PINCH_EXIT_THRESHOLD,
  HANDEDNESS_VOTE_WINDOW,
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

const handednessVotes = new Map<string, ("Left" | "Right")[]>();

export function resolveRoles(
  tracks: TrackedHand[],
  rawByTrackId: Map<string, RawHand>,
): TrackedHand[] {
  // Vote handedness per track
  for (const t of tracks) {
    const raw = rawByTrackId.get(t.trackId);
    if (!raw) continue;
    const arr = handednessVotes.get(t.trackId) ?? [];
    arr.push(raw.handedness);
    while (arr.length > HANDEDNESS_VOTE_WINDOW) arr.shift();
    handednessVotes.set(t.trackId, arr);
  }

  return tracks.map((t) => {
    const arr = handednessVotes.get(t.trackId) ?? [];
    const left = arr.filter((h) => h === "Left").length;
    const right = arr.length - left;
    // Role lock: keep existing role if any, otherwise assign by majority
    if (t.role) return t;
    if (arr.length < 3) return t;
    return { ...t, role: left >= right ? "control" : "pointer" };
  });
}

export function clearTrackingState(): void {
  handednessVotes.clear();
  nextTrackId = 1;
}

import {
  createDetector,
  SupportedModels,
  type HandDetector,
} from "@tensorflow-models/hand-pose-detection";
import "@tensorflow/tfjs-backend-webgl";
import * as tf from "@tensorflow/tfjs-core";

let detector: HandDetector | null = null;

export async function initDetector(): Promise<HandDetector> {
  if (detector) return detector;
  // tfjs runtime: pure WebGL, no MediaPipe IIFE, no solutionPath needed.
  // Same MediaPipe-trained landmark model under the hood, just orchestrated
  // by tfjs instead of MediaPipe's wasm. ~30-60fps on desktop is fine for
  // post-session graph review.
  await tf.setBackend("webgl");
  await tf.ready();
  detector = await createDetector(SupportedModels.MediaPipeHands, {
    runtime: "tfjs",
    modelType: "full",
    maxHands: 2,
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
