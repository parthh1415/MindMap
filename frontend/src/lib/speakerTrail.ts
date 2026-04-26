import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { useGraphStore, type SpeakerTrailPoint } from "@/state/graphStore";

// ─────────────────────────────────────────────────────────────────────
// Read hook
// ─────────────────────────────────────────────────────────────────────

/**
 * Returns the per-speaker trail points keyed by speaker_id. Uses
 * `useShallow` so identical-content maps compare equal — same trick
 * graphStore employs for its list selectors to keep React 18's
 * useSyncExternalStore happy.
 */
export function useSpeakerTrails(): Record<string, SpeakerTrailPoint[]> {
  return useGraphStore(useShallow((s) => s.speakerTrails));
}

// ─────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Drop trail points whose `ts` is older than `now - maxAgeMs`. Returns a
 * new map only when something actually changed; otherwise returns the
 * original reference (so React can bail on render).
 */
export function pruneSpeakerTrails(
  trails: Record<string, SpeakerTrailPoint[]>,
  now: number,
  maxAgeMs: number,
): Record<string, SpeakerTrailPoint[]> {
  const cutoff = now - maxAgeMs;
  let changed = false;
  const next: Record<string, SpeakerTrailPoint[]> = {};
  for (const [speakerId, points] of Object.entries(trails)) {
    const filtered = points.filter((p) => p.ts >= cutoff);
    if (filtered.length !== points.length) changed = true;
    if (filtered.length > 0) next[speakerId] = filtered;
    else if (points.length > 0) changed = true; // dropped entire entry
  }
  return changed ? next : trails;
}

/**
 * Convert trail points (ordered most-recent-first) to drawable polyline
 * coords using the live force-simulation `positions`. Skips points
 * whose entity is no longer in the simulation (entity removed).
 */
export function interpolatePolyline(
  points: SpeakerTrailPoint[],
  positions: Map<string, { x: number; y: number }>,
): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const p of points) {
    const xy = positions.get(p.entity_id);
    if (!xy) continue;
    out.push({ x: xy.x, y: xy.y });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// Decay hook
// ─────────────────────────────────────────────────────────────────────

const DECAY_INTERVAL_MS = 1000;

/**
 * Periodically prunes trail points older than `maxAgeMs`. Mount once in
 * GraphCanvasInner.
 */
export function useTrailDecayer(maxAgeMs = 14_000): void {
  useEffect(() => {
    const interval = window.setInterval(() => {
      const { speakerTrails } = useGraphStore.getState();
      const next = pruneSpeakerTrails(speakerTrails, Date.now(), maxAgeMs);
      if (next !== speakerTrails) {
        useGraphStore.setState({ speakerTrails: next });
      }
    }, DECAY_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [maxAgeMs]);
}
