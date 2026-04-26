import type { TrackedHand, GestureFrame } from "./types";
import {
  ROTATE_SENSITIVITY,
  ZOOM_DEPTH_SENSITIVITY,
  ZOOM_DEPTH_THRESHOLD,
  ZOOM_PINCH_SENSITIVITY,
  ZOOM_PINCH_THRESHOLD,
  DEPTH_DAMPING,
  MAX_ZOOM_STEP,
} from "./tunables";

interface ControlState {
  trackId: string;
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

interface PinchZoomState {
  pairKey: string | null;
  prevDistance: number;
}

/**
 * Gesture model (matches the friend's reference spec):
 *
 *   LEFT hand pinch  → ROTATE (wrist Δ → yaw/pitch)
 *   RIGHT hand pinch → ACTIVATE the hovered node (pinch-down edge)
 *   BOTH hands pinching → ZOOM (distance between wrists Δ → camera Z)
 *
 * Single-hand fallback: if only one hand is visible (regardless of its
 * handedness), pinching it rotates the graph. Activation requires two
 * hands (so the right-hand index can hover while the left controls).
 *
 * Roles are assigned INSTANTLY on the first frame from MediaPipe's
 * handedness label — no voting delay. See handTracking.resolveRoles.
 */
export function createGestureController() {
  let control: ControlState | null = null;
  let pointer: PointerState = { trackId: null, wasPinched: false };
  let pinchZoom: PinchZoomState = { pairKey: null, prevDistance: 0 };

  const update = (tracks: TrackedHand[]): GestureFrame => {
    const ctrlByRole = tracks.find((t) => t.role === "control");
    const ptrByRole = tracks.find((t) => t.role === "pointer");

    // Two-handed pinch zoom — both hands pinching, regardless of role.
    const pinchedHands = tracks.filter((t) => t.isPinched);
    const isTwoHandedZoom = pinchedHands.length >= 2;

    let rotateDelta: GestureFrame["rotateDelta"] = null;
    let zoomDelta: GestureFrame["zoomDelta"] = null;
    let pointerScreen: GestureFrame["pointerScreen"] = null;
    let pointerPinchEdge: GestureFrame["pointerPinchEdge"] = null;

    if (isTwoHandedZoom) {
      // ── Two-handed pinch-spread → zoom ──
      control = null; // suppress single-hand rotate baseline
      const a = pinchedHands[0]!;
      const b = pinchedHands[1]!;
      const wA = a.smoothed[0]!;
      const wB = b.smoothed[0]!;
      const dx = wA.x - wB.x;
      const dy = wA.y - wB.y;
      const distance = Math.hypot(dx, dy);
      const pairKey =
        a.trackId < b.trackId
          ? `${a.trackId}|${b.trackId}`
          : `${b.trackId}|${a.trackId}`;
      if (pinchZoom.pairKey === pairKey && pinchZoom.prevDistance > 0) {
        const distDelta = distance - pinchZoom.prevDistance;
        if (Math.abs(distDelta) > ZOOM_PINCH_THRESHOLD) {
          // Hands moving APART → zoom IN → camera Z decreases.
          let step = -distDelta * ZOOM_PINCH_SENSITIVITY;
          if (step > MAX_ZOOM_STEP) step = MAX_ZOOM_STEP;
          if (step < -MAX_ZOOM_STEP) step = -MAX_ZOOM_STEP;
          zoomDelta = step;
        }
      }
      pinchZoom = { pairKey, prevDistance: distance };
    } else {
      pinchZoom = { pairKey: null, prevDistance: 0 };
    }

    // ── Rotation: LEFT hand pinch (control role) drives yaw/pitch.
    //    Single-hand fallback: if only one hand is visible regardless
    //    of role, treat ITS pinch as rotation.
    const rotater =
      tracks.length === 1 && tracks[0]!.isPinched
        ? tracks[0]
        : ctrlByRole && ctrlByRole.isPinched
          ? ctrlByRole
          : undefined;

    if (rotater && !isTwoHandedZoom) {
      const w = rotater.smoothed[0]!;
      const ctrlBoundChanged =
        control != null && control.trackId !== rotater.trackId;
      const canRotate =
        control != null && control.wasPinched && !ctrlBoundChanged;
      if (canRotate && control) {
        const dx = w.x - control.prevWristX;
        const dy = w.y - control.prevWristY;
        rotateDelta = {
          yaw: -dx * ROTATE_SENSITIVITY,
          pitch: -dy * ROTATE_SENSITIVITY,
        };
        // Single-hand depth zoom — fallback for users with only one
        // hand. Mono-z is noisy so heavily damped + threshold-gated.
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
          trackId: rotater.trackId,
          prevWristX: w.x,
          prevWristY: w.y,
          prevWristZ: w.z,
          smoothedZ: newSmoothed,
          wasPinched: true,
        };
      } else {
        control = {
          trackId: rotater.trackId,
          prevWristX: w.x,
          prevWristY: w.y,
          prevWristZ: w.z,
          smoothedZ: control?.smoothedZ ?? w.z,
          wasPinched: rotater.isPinched,
        };
      }
    } else {
      // No active rotater — clear baseline so re-engaging is clean.
      control = null;
    }

    // ── Pointer: RIGHT hand index fingertip + pinch-down activates. ──
    // Always runs (even in two-hand zoom) so the FRAME a user starts
    // pinching the right hand fires the activation edge before the
    // sustained two-pinch is interpreted as zoom.
    const ptr = ptrByRole ?? (tracks.length === 1 ? undefined : tracks[1]);
    if (ptr) {
      const tip = ptr.smoothed[8]!;
      pointerScreen = { x: tip.x, y: tip.y };
      const ptrBoundChanged = pointer.trackId !== ptr.trackId;
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
    pinchZoom = { pairKey: null, prevDistance: 0 };
  };

  return { update, reset };
}
