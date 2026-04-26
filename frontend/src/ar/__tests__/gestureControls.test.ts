import { describe, it, expect, beforeEach } from "vitest";
import { createGestureController } from "@/ar/gestureControls";
import type { TrackedHand, Landmark } from "@/ar/types";

const mkHand = (
  trackId: string, role: "control" | "pointer", wristX: number, wristY: number, wristZ: number,
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

describe("gestureController", () => {
  let g: ReturnType<typeof createGestureController>;
  beforeEach(() => { g = createGestureController(); });

  it("returns zero rotateDelta when control hand not pinched", () => {
    const f = g.update([mkHand("a", "control", 100, 100, 0, false)]);
    expect(f.rotateDelta).toBeNull();
    expect(f.zoomDelta).toBeNull();
  });

  it("emits rotateDelta on pinched control hand wrist movement", () => {
    g.update([mkHand("a", "control", 100, 100, 0, true)]);
    const f = g.update([mkHand("a", "control", 110, 90, 0, true)]);
    expect(f.rotateDelta).not.toBeNull();
    expect(Math.abs(f.rotateDelta!.yaw)).toBeGreaterThan(0);
    expect(Math.abs(f.rotateDelta!.pitch)).toBeGreaterThan(0);
  });

  it("emits zoomDelta from wrist.z change while pinched", () => {
    g.update([mkHand("a", "control", 100, 100, 0.5, true)]);
    const f = g.update([mkHand("a", "control", 100, 100, 0.6, true)]);
    expect(f.zoomDelta).not.toBeNull();
    expect(f.zoomDelta).not.toBe(0);
  });

  it("ignores zoomDelta below threshold", () => {
    g.update([mkHand("a", "control", 100, 100, 0.5, true)]);
    const f = g.update([mkHand("a", "control", 100, 100, 0.5005, true)]);
    expect(f.zoomDelta).toBeNull();
  });

  it("emits pointerScreen for pointer hand index fingertip", () => {
    const f = g.update([mkHand("a", "pointer", 100, 100, 0, false)]);
    expect(f.pointerScreen).toEqual({ x: 130, y: 130 });
  });

  it("emits pinchEdge='down' once on pointer pinch start", () => {
    const f1 = g.update([mkHand("a", "pointer", 100, 100, 0, true)]);
    const f2 = g.update([mkHand("a", "pointer", 100, 100, 0, true)]);
    expect(f1.pointerPinchEdge).toBe("down");
    expect(f2.pointerPinchEdge).toBeNull();
  });
});
