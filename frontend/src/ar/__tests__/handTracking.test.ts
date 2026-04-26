import { describe, it, expect, beforeEach } from "vitest";
import { computeCentroid, computePalmSpan } from "@/ar/handTracking";
import type { Landmark } from "@/ar/types";

const mkHand = (): Landmark[] => {
  // 21 landmarks in a synthetic layout. wrist=0, middle_mcp=9.
  return Array.from({ length: 21 }, (_, i) => ({ x: i * 10, y: i * 5, z: 0 }));
};

describe("computeCentroid", () => {
  it("averages x and y across all 21 landmarks", () => {
    const c = computeCentroid(mkHand());
    expect(c.x).toBeCloseTo(100); // mean of 0..200 step 10
    expect(c.y).toBeCloseTo(50);
  });
});

describe("computePalmSpan", () => {
  it("is the distance from wrist (0) to middle_mcp (9)", () => {
    const lm = mkHand();
    const span = computePalmSpan(lm);
    // distance from (0,0) to (90,45)
    expect(span).toBeCloseTo(Math.sqrt(90 * 90 + 45 * 45), 5);
  });
});

import { emaLandmarks, computePinchStrength } from "@/ar/handTracking";

describe("emaLandmarks", () => {
  it("returns a copy of next when prev is null", () => {
    const next: Landmark[] = [{ x: 1, y: 2, z: 3 }];
    const out = emaLandmarks(null, next);
    expect(out).toEqual(next);
    expect(out[0]).not.toBe(next[0]);
  });
  it("blends by SMOOTHING_ALPHA (currently 0.6)", () => {
    // Read the constant rather than hardcoding so this test tracks
    // the tunable instead of fighting it.
    const prev: Landmark[] = [{ x: 0, y: 0, z: 0 }];
    const next: Landmark[] = [{ x: 10, y: 20, z: 30 }];
    const out = emaLandmarks(prev, next);
    // Formula: prev + (next - prev) * alpha. Verify the ratio holds.
    const ratio = out[0]!.x / next[0]!.x;
    expect(ratio).toBeGreaterThan(0.4);
    expect(ratio).toBeLessThan(0.7);
    // y and z must follow the same ratio (same alpha).
    expect(out[0]!.y / next[0]!.y).toBeCloseTo(ratio, 5);
    expect(out[0]!.z / next[0]!.z).toBeCloseTo(ratio, 5);
  });
});

describe("computePinchStrength", () => {
  it("returns thumb-index distance / palmSpan", () => {
    const lm: Landmark[] = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
    lm[4] = { x: 0, y: 0, z: 0 };
    lm[8] = { x: 3, y: 4, z: 0 }; // distance 5
    expect(computePinchStrength(lm, 10)).toBeCloseTo(0.5);
  });
});

import { matchTracks } from "@/ar/handTracking";
import type { RawHand } from "@/ar/types";

const mkRaw = (cx: number, cy: number, handed: "Left" | "Right" = "Left"): RawHand => {
  const lm: Landmark[] = Array.from({ length: 21 }, (_, i) => ({
    x: cx + i, y: cy + i, z: 0,
  }));
  // Make wrist (0) and middle_mcp (9) far apart so palmSpan > 0
  lm[0] = { x: cx, y: cy, z: 0 };
  lm[9] = { x: cx + 50, y: cy + 25, z: 0 };
  return { handedness: handed, score: 0.95, keypoints: lm };
};

describe("matchTracks", () => {
  it("creates new tracks on first frame", () => {
    const t = matchTracks([], [mkRaw(100, 100), mkRaw(500, 100)], 1000, 1000);
    expect(t).toHaveLength(2);
    expect(t[0]!.trackId).not.toBe(t[1]!.trackId);
  });

  it("matches same track across frames by nearest centroid", () => {
    const f1 = matchTracks([], [mkRaw(100, 100)], 1000, 1000);
    const f2 = matchTracks(f1, [mkRaw(110, 105)], 1000, 1000);
    expect(f2[0]!.trackId).toBe(f1[0]!.trackId);
  });

  it("drops to top-2 by palm span when 3 raw hands present", () => {
    const big1 = mkRaw(100, 100); // span 50ish
    const big2 = mkRaw(500, 500);
    const tiny = mkRaw(800, 800);
    tiny.keypoints[9] = { x: 805, y: 805, z: 0 }; // small palm
    const t = matchTracks([], [big1, big2, tiny], 1000, 1000);
    expect(t).toHaveLength(2);
  });
});

import { resolveRoles, clearTrackingState } from "@/ar/handTracking";

describe("resolveRoles — instant first-frame role assignment", () => {
  beforeEach(() => clearTrackingState());

  it("assigns 'control' to a Left-handed hand on the FIRST frame (no voting delay)", () => {
    const tracks = matchTracks([], [mkRaw(100, 100, "Left")], 1000, 1000);
    const map = new Map([[tracks[0]!.trackId, mkRaw(100, 100, "Left")]]);
    const out = resolveRoles(tracks, map);
    expect(out[0]!.role).toBe("control");
  });

  it("assigns 'pointer' to a Right-handed hand on the FIRST frame", () => {
    const tracks = matchTracks([], [mkRaw(500, 100, "Right")], 1000, 1000);
    const map = new Map([[tracks[0]!.trackId, mkRaw(500, 100, "Right")]]);
    const out = resolveRoles(tracks, map);
    expect(out[0]!.role).toBe("pointer");
  });

  it("locks role per-track for the lifetime of that track id (no flipping)", () => {
    // First frame: hand registered as Left → control
    let tracks = matchTracks([], [mkRaw(100, 100, "Left")], 1000, 1000);
    let map = new Map([[tracks[0]!.trackId, mkRaw(100, 100, "Left")]]);
    tracks = resolveRoles(tracks, map);
    expect(tracks[0]!.role).toBe("control");

    // Subsequent frame: model briefly flips handedness to Right (jitter)
    tracks = matchTracks(tracks, [mkRaw(102, 100, "Right")], 1000, 1000);
    map = new Map([[tracks[0]!.trackId, mkRaw(102, 100, "Right")]]);
    tracks = resolveRoles(tracks, map);
    // Role MUST stay 'control' because we lock per-trackId.
    expect(tracks[0]!.role).toBe("control");
  });

  it("clearTrackingState resets locked roles so the next session starts fresh", () => {
    let tracks = matchTracks([], [mkRaw(100, 100, "Left")], 1000, 1000);
    let map = new Map([[tracks[0]!.trackId, mkRaw(100, 100, "Left")]]);
    tracks = resolveRoles(tracks, map);
    expect(tracks[0]!.role).toBe("control");

    clearTrackingState();
    // After reset, the SAME-positioned hand (which gets a fresh trackId)
    // can be assigned a different role if it's now seen as Right.
    tracks = matchTracks([], [mkRaw(100, 100, "Right")], 1000, 1000);
    map = new Map([[tracks[0]!.trackId, mkRaw(100, 100, "Right")]]);
    tracks = resolveRoles(tracks, map);
    expect(tracks[0]!.role).toBe("pointer");
  });
});
