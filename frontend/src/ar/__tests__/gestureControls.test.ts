import { describe, it, expect, beforeEach } from "vitest";
import { createGestureController } from "@/ar/gestureControls";
import type { TrackedHand, Landmark } from "@/ar/types";

const mkHand = (
  trackId: string,
  role: "control" | "pointer" | null,
  wristX: number,
  wristY: number,
  wristZ: number,
  pinched: boolean,
): TrackedHand => {
  const lm: Landmark[] = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
  lm[0] = { x: wristX, y: wristY, z: wristZ };
  lm[9] = { x: wristX + 50, y: wristY + 25, z: wristZ };
  lm[8] = { x: wristX + 30, y: wristY + 30, z: wristZ }; // index tip
  return {
    trackId, role, smoothed: lm,
    centroid: { x: wristX, y: wristY },
    palmSpan: 50, pinchStrength: pinched ? 0.04 : 0.1,
    isPinched: pinched, framesSinceSeen: 0,
  };
};

describe("gestureController — single-hand baseline", () => {
  let g: ReturnType<typeof createGestureController>;
  beforeEach(() => { g = createGestureController(); });

  it("emits no rotateDelta or zoomDelta on a single non-pinching hand", () => {
    const f = g.update([mkHand("a", null, 100, 100, 0, false)]);
    expect(f.rotateDelta).toBeNull();
    expect(f.zoomDelta).toBeNull();
  });

  it("emits rotateDelta on the SECOND consecutive pinched frame as the wrist moves (single-hand pinch)", () => {
    g.update([mkHand("a", null, 100, 100, 0, true)]);
    const f = g.update([mkHand("a", null, 110, 90, 0, true)]);
    expect(f.rotateDelta).not.toBeNull();
    expect(Math.abs(f.rotateDelta!.yaw)).toBeGreaterThan(0);
    expect(Math.abs(f.rotateDelta!.pitch)).toBeGreaterThan(0);
  });

  it("emits zoomDelta from wrist.z change while pinched", () => {
    g.update([mkHand("a", null, 100, 100, 0.5, true)]);
    const f = g.update([mkHand("a", null, 100, 100, 0.6, true)]);
    expect(f.zoomDelta).not.toBeNull();
    expect(f.zoomDelta).not.toBe(0);
  });

  it("ignores zoomDelta below threshold", () => {
    g.update([mkHand("a", null, 100, 100, 0.5, true)]);
    const f = g.update([mkHand("a", null, 100, 100, 0.5005, true)]);
    expect(f.zoomDelta).toBeNull();
  });
});

describe("gestureController — engages on first pinched frame regardless of role lock", () => {
  let g: ReturnType<typeof createGestureController>;
  beforeEach(() => { g = createGestureController(); });

  it("a hand pinching with NO role lock yet still becomes the controller", () => {
    // role is null (handedness voting hasn't settled)
    g.update([mkHand("a", null, 100, 100, 0, true)]);
    const f = g.update([mkHand("a", null, 110, 100, 0, true)]);
    expect(f.rotateDelta).not.toBeNull();
    expect(Math.abs(f.rotateDelta!.yaw)).toBeGreaterThan(0);
  });

  it("a hand role-locked as 'pointer' still drives rotation if it's the only one pinching", () => {
    // Pre-lock semantics would have ignored this hand entirely.
    g.update([mkHand("a", "pointer", 100, 100, 0, true)]);
    const f = g.update([mkHand("a", "pointer", 115, 100, 0, true)]);
    expect(f.rotateDelta).not.toBeNull();
    expect(Math.abs(f.rotateDelta!.yaw)).toBeGreaterThan(0);
  });
});

describe("gestureController — two-hand pointer + control", () => {
  let g: ReturnType<typeof createGestureController>;
  beforeEach(() => { g = createGestureController(); });

  const ctrlHand = (pinched: boolean) =>
    mkHand("ctrl", null, 100, 100, 0, pinched);
  const ptrHand = (wristX: number, pinched: boolean) =>
    mkHand("ptr", null, wristX, 200, 0, pinched);

  it("non-pinching second hand exposes its index fingertip as pointerScreen", () => {
    const f = g.update([ctrlHand(true), ptrHand(400, false)]);
    // Pointer fingertip is at (wristX + 30, wristY + 30) per mkHand.
    expect(f.pointerScreen).toEqual({ x: 430, y: 230 });
  });

  it("pointer pinch transition fires pinchEdge='down' exactly once", () => {
    // Frame 1: ctrl pinching, ptr open → no edge
    const f1 = g.update([ctrlHand(true), ptrHand(400, false)]);
    expect(f1.pointerPinchEdge).toBeNull();
    // Frame 2: ctrl still pinching, ptr just closed → edge=down
    const f2 = g.update([ctrlHand(true), ptrHand(400, true)]);
    expect(f2.pointerPinchEdge).toBe("down");
    // Frame 3: ctrl still pinching, ptr still closed → null again
    const f3 = g.update([ctrlHand(true), ptrHand(400, true)]);
    expect(f3.pointerPinchEdge).toBeNull();
  });
});

describe("gestureController — two-handed pinch-spread zoom", () => {
  let g: ReturnType<typeof createGestureController>;
  beforeEach(() => { g = createGestureController(); });

  it("emits zoomDelta when both hands pinch and move APART (zoom IN — negative dZ)", () => {
    // Frame 1: both hands pinching, distance baseline.
    g.update([
      mkHand("L", null, 100, 100, 0, true),
      mkHand("R", null, 200, 100, 0, true),
    ]);
    // Frame 2: hands moved apart — L moves left, R moves right.
    const f = g.update([
      mkHand("L", null, 80, 100, 0, true),
      mkHand("R", null, 220, 100, 0, true),
    ]);
    expect(f.zoomDelta).not.toBeNull();
    // Hands moving apart → zoom IN → camera Z DECREASES → negative delta.
    expect(f.zoomDelta!).toBeLessThan(0);
  });

  it("emits positive zoomDelta when both hands pinch and move TOGETHER (zoom OUT)", () => {
    g.update([
      mkHand("L", null, 80, 100, 0, true),
      mkHand("R", null, 220, 100, 0, true),
    ]);
    const f = g.update([
      mkHand("L", null, 100, 100, 0, true),
      mkHand("R", null, 200, 100, 0, true),
    ]);
    expect(f.zoomDelta).not.toBeNull();
    expect(f.zoomDelta!).toBeGreaterThan(0);
  });

  it("ignores tiny distance jitter below the pinch-zoom threshold", () => {
    g.update([
      mkHand("L", null, 100, 100, 0, true),
      mkHand("R", null, 200, 100, 0, true),
    ]);
    // Sub-pixel jitter — way below ZOOM_PINCH_THRESHOLD (1.5px).
    const f = g.update([
      mkHand("L", null, 100.3, 100, 0, true),
      mkHand("R", null, 200.2, 100, 0, true),
    ]);
    expect(f.zoomDelta).toBeNull();
  });

  it("suppresses rotation while both hands are pinching", () => {
    g.update([
      mkHand("L", null, 100, 100, 0, true),
      mkHand("R", null, 200, 100, 0, true),
    ]);
    // Both hands move horizontally (would rotate yaw under single-hand
    // semantics) but we're in two-hand zoom mode, so no rotateDelta.
    const f = g.update([
      mkHand("L", null, 130, 100, 0, true),
      mkHand("R", null, 230, 100, 0, true),
    ]);
    expect(f.rotateDelta).toBeNull();
  });

  it("resets zoom baseline when a hand stops pinching (no spurious delta)", () => {
    // Frame 1: both pinching, far apart.
    g.update([
      mkHand("L", null, 50, 100, 0, true),
      mkHand("R", null, 250, 100, 0, true),
    ]);
    // Frame 2: only L still pinched (back to single-hand mode).
    g.update([
      mkHand("L", null, 50, 100, 0, true),
      mkHand("R", null, 250, 100, 0, false),
    ]);
    // Frame 3: both pinching again at a NEW distance — must NOT
    // compare against the stale 200-px frame-1 baseline.
    const f = g.update([
      mkHand("L", null, 60, 100, 0, true),
      mkHand("R", null, 240, 100, 0, true),
    ]);
    // First frame back in two-hand mode → no zoom delta yet (just
    // re-established baseline).
    expect(f.zoomDelta).toBeNull();
  });
});

describe("gestureController — ctrl swap mid-session", () => {
  let g: ReturnType<typeof createGestureController>;
  beforeEach(() => { g = createGestureController(); });

  it("does NOT produce a rotation jump when the ctrl hand changes between frames", () => {
    // Hand "a" is pinched at (100, 100). Becomes ctrl, baseline is set.
    g.update([mkHand("a", null, 100, 100, 0, true)]);
    g.update([mkHand("a", null, 102, 100, 0, true)]); // small valid rotate

    // Hand "a" releases pinch, hand "b" pinches at (500, 500) — far away.
    // Without ctrl-swap protection we'd compute rotation from (500-102) →
    // a huge spurious yaw jump. With protection, the new ctrl
    // re-establishes its baseline and the next frame produces a normal
    // small delta only when "b" actually moves.
    const f = g.update([
      mkHand("a", null, 102, 100, 0, false),
      mkHand("b", null, 500, 500, 0, true),
    ]);
    // Either no rotation this frame, OR rotation magnitude is small
    // (within a single-hand-movement reasonable range, not the full
    // 400-px wrist gap between two hands).
    if (f.rotateDelta) {
      expect(Math.abs(f.rotateDelta.yaw)).toBeLessThan(0.5);
    }
  });
});
