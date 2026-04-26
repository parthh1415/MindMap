import type { TrackedHand, GestureFrame } from "./types";
import {
  ROTATE_SENSITIVITY,
  ZOOM_DEPTH_SENSITIVITY,
  ZOOM_DEPTH_THRESHOLD,
  DEPTH_DAMPING,
  MAX_ZOOM_STEP,
} from "./tunables";

interface ControlState {
  trackId: string;            // ID of the hand currently bound as ctrl
  prevWristX: number;
  prevWristY: number;
  prevWristZ: number;
  smoothedZ: number;
  wasPinched: boolean;
}

interface PointerState {
  trackId: string | null;
  wasPinched: boolean;
}

export function createGestureController() {
  let control: ControlState | null = null;
  let pointer: PointerState = { trackId: null, wasPinched: false };

  const update = (tracks: TrackedHand[]): GestureFrame => {
    // ── Role assignment without role-lock dependency ──
    //
    // Original failure mode: ctrl required role === "control" which
    // takes 3+ frames of handedness voting to resolve. Users pinching
    // during that window saw no rotation. New semantics:
    //
    //   - ctrl  = any currently-pinching hand (pinching IS the engage
    //             gesture). Falls back to role-locked "control" if no
    //             pinch, then to first track (single-hand UX).
    //   - ptr   = a different track from ctrl (so single-hand pinch
    //             rotates without trying to also point/activate the
    //             same hand).
    //
    // ctrl can swap mid-session if the user releases one hand and
    // pinches with the other. We track ctrl trackId and reset the
    // wrist baseline on swap to avoid a rotation-jump.
    const pinchingTrack = tracks.find((t) => t.isPinched);
    const ctrl =
      pinchingTrack ??
      tracks.find((t) => t.role === "control") ??
      tracks[0];
    const ptr = ctrl
      ? tracks.find((t) => t !== ctrl && t.role === "pointer") ??
        tracks.find((t) => t !== ctrl)
      : tracks.find((t) => t.role === "pointer") ?? tracks[0];

    let rotateDelta: GestureFrame["rotateDelta"] = null;
    let zoomDelta: GestureFrame["zoomDelta"] = null;
    let pointerScreen: GestureFrame["pointerScreen"] = null;
    let pointerPinchEdge: GestureFrame["pointerPinchEdge"] = null;

    // ── Control hand → rotate + zoom while pinched ──
    if (ctrl) {
      const w = ctrl.smoothed[0]!;
      const ctrlBoundChanged =
        control != null && control.trackId !== ctrl.trackId;
      const canRotate =
        ctrl.isPinched &&
        control != null &&
        control.wasPinched &&
        !ctrlBoundChanged; // never rotate using a stale wrist baseline
      if (canRotate && control) {
        const dx = w.x - control.prevWristX;
        const dy = w.y - control.prevWristY;
        rotateDelta = {
          yaw: -dx * ROTATE_SENSITIVITY,
          pitch: -dy * ROTATE_SENSITIVITY,
        };
        const newSmoothed =
          control.smoothedZ + (w.z - control.smoothedZ) * DEPTH_DAMPING;
        const dz = newSmoothed - control.smoothedZ;
        if (Math.abs(dz) > ZOOM_DEPTH_THRESHOLD) {
          let step = dz * ZOOM_DEPTH_SENSITIVITY;
          if (step > MAX_ZOOM_STEP) step = MAX_ZOOM_STEP;
          if (step < -MAX_ZOOM_STEP) step = -MAX_ZOOM_STEP;
          zoomDelta = step;
        }
        control = {
          trackId: ctrl.trackId,
          prevWristX: w.x,
          prevWristY: w.y,
          prevWristZ: w.z,
          smoothedZ: newSmoothed,
          wasPinched: true,
        };
      } else {
        // Re-establish baseline (new ctrl bind, or not pinched yet).
        control = {
          trackId: ctrl.trackId,
          prevWristX: w.x,
          prevWristY: w.y,
          prevWristZ: w.z,
          smoothedZ: control?.smoothedZ ?? w.z,
          wasPinched: ctrl.isPinched,
        };
      }
    } else {
      control = null;
    }

    // ── Pointer hand → fingertip position + pinch edge ──
    if (ptr) {
      const tip = ptr.smoothed[8]!;
      pointerScreen = { x: tip.x, y: tip.y };
      const ptrBoundChanged = pointer.trackId !== ptr.trackId;
      // Edge transitions only fire if same hand kept pointer role
      // across frames — otherwise a hand swap would spuriously fire
      // 'down' as the new ptr's pinch state read against the old.
      if (!ptrBoundChanged) {
        if (ptr.isPinched && !pointer.wasPinched) pointerPinchEdge = "down";
        else if (!ptr.isPinched && pointer.wasPinched) pointerPinchEdge = "up";
      }
      pointer = { trackId: ptr.trackId, wasPinched: ptr.isPinched };
    } else {
      pointer = { trackId: null, wasPinched: false };
    }

    return { rotateDelta, zoomDelta, pointerScreen, pointerPinchEdge };
  };

  const reset = () => {
    control = null;
    pointer = { trackId: null, wasPinched: false };
  };

  return { update, reset };
}
