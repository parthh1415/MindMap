// All physics/feel constants in one place. Adjust here, never inline.

// Smoothing: higher alpha = MORE responsive (less smoothing). Was 0.5;
// 0.6 gives crisper tracking with marginal jitter increase.
export const SMOOTHING_ALPHA = 0.6;
export const TRACK_MATCH_MAX_DISTANCE = 0.25;

// Slower, smoother, more precise — wrist movements translate to small
// rotations + the lerp damping is gentle so the graph eases into pose
// rather than snapping.
export const ROTATE_SENSITIVITY = 0.006;
export const ROTATION_DAMPING = 0.08;

// Two-hand pinch-spread zoom (the trackpad gesture, universally
// understood). Distance between two pinching wrists drives zoom:
//   - hands moving APART  → zoom IN (camera Z decreases)
//   - hands moving TOGETHER → zoom OUT (camera Z increases)
// Sensitivity converts wrist-pixel-distance Δ to camera-Z delta.
export const ZOOM_PINCH_SENSITIVITY = 0.015;
// Min wrist-distance Δ (in pixels) per frame to count — kills jitter.
export const ZOOM_PINCH_THRESHOLD = 1.5;

// Single-hand depth zoom (fallback when only one hand is pinching).
// Mono webcam wrist.z is noisy — these constants tolerate that.
export const ZOOM_DEPTH_SENSITIVITY = 5.0;
export const ZOOM_DEPTH_THRESHOLD = 0.0015;
export const DEPTH_DAMPING = 0.45;
export const MAX_ZOOM_STEP = 0.4;
export const ZOOM_CAMERA_DAMPING = 0.08;

// Pinch detection uses (thumb-tip ↔ index-tip distance) / palm-span.
// Was 0.045/0.06 (friend's spec — fingertips almost touching),
// then 0.085/0.13 (still too tight for casual pinching),
// now 0.22/0.34 — engages on a comfortable "okay" gesture and
// disengages cleanly when fingers fully spread. Real-world casual
// pinches register reliably at this threshold.
export const PINCH_ENTER_THRESHOLD = 0.22;
export const PINCH_EXIT_THRESHOLD = 0.34;

export const CAMERA_Z_MIN = 1.5;
export const CAMERA_Z_MAX = 12.0;
export const CAMERA_Z_DEFAULT = 5.0;

export const POINTER_PICK_RADIUS_PX = 56;

export const HANDEDNESS_VOTE_WINDOW = 8;
export const ROLE_LOCK_HOLD_FRAMES = 30;

export const TARGET_GRAPH_RADIUS = 2.0;
export const FORCE_SIM_ITERATIONS = 200;

// Hold-pinch on the right hand: continuous pinch over a hovered orb for
// this many ms triggers the "expand context" action. Quick pinches under
// the threshold remain the existing activate/mark gesture, so the two
// behaviours coexist on the same hand without a new gesture vocabulary.
export const HOLD_PINCH_MS = 350;
