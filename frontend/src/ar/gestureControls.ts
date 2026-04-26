import type { TrackedHand, GestureFrame } from "./types";
import {
  ROTATE_SENSITIVITY,
  ZOOM_DEPTH_SENSITIVITY,
  ZOOM_DEPTH_THRESHOLD,
  DEPTH_DAMPING,
  MAX_ZOOM_STEP,
} from "./tunables";

interface ControlState {
  prevWristX: number;
  prevWristY: number;
  prevWristZ: number;
  smoothedZ: number;
  wasPinched: boolean;
}

interface PointerState {
  wasPinched: boolean;
}

export function createGestureController() {
  let control: ControlState | null = null;
  let pointer: PointerState = { wasPinched: false };

  const update = (tracks: TrackedHand[]): GestureFrame => {
    const ctrl = tracks.find((t) => t.role === "control");
    const ptr = tracks.find((t) => t.role === "pointer");

    let rotateDelta: GestureFrame["rotateDelta"] = null;
    let zoomDelta: GestureFrame["zoomDelta"] = null;
    let pointerScreen: GestureFrame["pointerScreen"] = null;
    let pointerPinchEdge: GestureFrame["pointerPinchEdge"] = null;

    // Control hand → rotate + zoom (only while pinched)
    if (ctrl) {
      const w = ctrl.smoothed[0]!;
      if (ctrl.isPinched && control && control.wasPinched) {
        const dx = w.x - control.prevWristX;
        const dy = w.y - control.prevWristY;
        rotateDelta = {
          yaw: -dx * ROTATE_SENSITIVITY,
          pitch: -dy * ROTATE_SENSITIVITY,
        };
        const newSmoothed = control.smoothedZ + (w.z - control.smoothedZ) * DEPTH_DAMPING;
        const dz = newSmoothed - control.smoothedZ;
        if (Math.abs(dz) > ZOOM_DEPTH_THRESHOLD) {
          let step = dz * ZOOM_DEPTH_SENSITIVITY;
          if (step > MAX_ZOOM_STEP) step = MAX_ZOOM_STEP;
          if (step < -MAX_ZOOM_STEP) step = -MAX_ZOOM_STEP;
          zoomDelta = step;
        }
        control = {
          prevWristX: w.x, prevWristY: w.y, prevWristZ: w.z,
          smoothedZ: newSmoothed, wasPinched: true,
        };
      } else {
        control = {
          prevWristX: w.x, prevWristY: w.y, prevWristZ: w.z,
          smoothedZ: control?.smoothedZ ?? w.z,
          wasPinched: ctrl.isPinched,
        };
      }
    } else {
      control = null;
    }

    // Pointer hand → fingertip position + pinch edge
    if (ptr) {
      const tip = ptr.smoothed[8]!;
      pointerScreen = { x: tip.x, y: tip.y };
      if (ptr.isPinched && !pointer.wasPinched) pointerPinchEdge = "down";
      else if (!ptr.isPinched && pointer.wasPinched) pointerPinchEdge = "up";
      pointer = { wasPinched: ptr.isPinched };
    } else {
      pointer = { wasPinched: false };
    }

    return { rotateDelta, zoomDelta, pointerScreen, pointerPinchEdge };
  };

  const reset = () => {
    control = null;
    pointer = { wasPinched: false };
  };

  return { update, reset };
}
