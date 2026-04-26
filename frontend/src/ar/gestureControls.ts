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

interface PinchZoomState {
  // Composite key of both pinching hands so a swap (e.g. user momentarily
  // releases and re-pinches) doesn't carry over a stale prev distance.
  pairKey: string | null;
  prevDistance: number;
}

export function createGestureController() {
  let control: ControlState | null = null;
  let pointer: PointerState = { trackId: null, wasPinched: false };
  let pinchZoom: PinchZoomState = { pairKey: null, prevDistance: 0 };

  const update = (tracks: TrackedHand[]): GestureFrame => {
    // Two-handed pinch-spread is the universal trackpad/phone zoom
    // gesture and the most reliable way to zoom on monocular hand
    // tracking (mono z-depth from one webcam is too noisy). When two
    // hands are pinching simultaneously, the distance between their
    // wrists drives zoom and rotation is suppressed (the user is
    // "grabbing" the graph, not turning it).
    const pinchedHands = tracks.filter((t) => t.isPinched);
    const isTwoHandedZoom = pinchedHands.length >= 2;

    let rotateDelta: GestureFrame["rotateDelta"] = null;
    let zoomDelta: GestureFrame["zoomDelta"] = null;
    let pointerScreen: GestureFrame["pointerScreen"] = null;
    let pointerPinchEdge: GestureFrame["pointerPinchEdge"] = null;

    if (isTwoHandedZoom) {
      // ── Two-handed pinch-spread → zoom ──
      // Reset single-hand controller so the next frame after release
      // re-establishes baseline cleanly.
      control = null;
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
          // distDelta positive when apart → zoomDelta should be negative.
          let step = -distDelta * ZOOM_PINCH_SENSITIVITY;
          if (step > MAX_ZOOM_STEP) step = MAX_ZOOM_STEP;
          if (step < -MAX_ZOOM_STEP) step = -MAX_ZOOM_STEP;
          zoomDelta = step;
        }
      }
      pinchZoom = { pairKey, prevDistance: distance };
    } else {
      // No two-handed grab — clear pinch-zoom baseline so re-engaging
      // doesn't snap from stale state.
      pinchZoom = { pairKey: null, prevDistance: 0 };
    }

    // ── Single-hand controller selection (rotate + fallback depth zoom) ──
    //
    // ctrl = any pinching hand (when only ONE is pinching), else the
    // role-locked control hand, else the first track. ptr = a different
    // track. Rotation is suppressed while we're in two-handed zoom mode.
    const singlePinchTrack =
      pinchedHands.length === 1 ? pinchedHands[0]! : undefined;
    const ctrl =
      singlePinchTrack ??
      tracks.find((t) => t.role === "control") ??
      tracks[0];
    const ptr = ctrl
      ? tracks.find((t) => t !== ctrl && t.role === "pointer") ??
        tracks.find((t) => t !== ctrl)
      : tracks.find((t) => t.role === "pointer") ?? tracks[0];

    if (ctrl && !isTwoHandedZoom) {
      const w = ctrl.smoothed[0]!;
      const ctrlBoundChanged =
        control != null && control.trackId !== ctrl.trackId;
      const canRotate =
        ctrl.isPinched &&
        control != null &&
        control.wasPinched &&
        !ctrlBoundChanged;
      if (canRotate && control) {
        const dx = w.x - control.prevWristX;
        const dy = w.y - control.prevWristY;
        rotateDelta = {
          yaw: -dx * ROTATE_SENSITIVITY,
          pitch: -dy * ROTATE_SENSITIVITY,
        };
        // Single-hand depth zoom — fallback when the user has only
        // one hand visible. Mono z is noisy so this is heavily damped
        // and threshold-gated. Two-handed pinch is the better path.
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
    } else if (!ctrl) {
      control = null;
    }

    // ── Pointer hand → fingertip position + pinch edge ──
    // Always runs (even in two-hand zoom mode) — the pinch-down EDGE
    // is the "activate hovered node" gesture, and we want it to fire
    // on the FRAME the second hand starts pinching, even if subsequent
    // frames will be interpreted as a zoom drag. So:
    //   Frame N:    ptr just pinched → pinchEdge="down" (activate)
    //   Frame N+1+: both hands stay pinched → zoom from distance Δ
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
