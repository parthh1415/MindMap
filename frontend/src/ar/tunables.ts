// All physics/feel constants in one place. Adjust here, never inline.

export const SMOOTHING_ALPHA = 0.5;
export const TRACK_MATCH_MAX_DISTANCE = 0.25;

// Slower, smoother, more precise — wrist movements translate to small
// rotations + the lerp damping is gentle so the graph eases into pose
// rather than snapping.
export const ROTATE_SENSITIVITY = 0.006;
export const ROTATION_DAMPING = 0.08;

// Zoom: tiny per-frame steps + heavier damping = gradual continuous
// zoom rather than jerky steps.
export const ZOOM_DEPTH_SENSITIVITY = 5.0;
export const ZOOM_DEPTH_THRESHOLD = 0.0015;
export const DEPTH_DAMPING = 0.45;
export const MAX_ZOOM_STEP = 0.25;
export const ZOOM_CAMERA_DAMPING = 0.06;

// Pinch detection uses (thumb-tip ↔ index-tip distance) / palm-span.
// Forgiving thresholds — pinch engages well before fingertips touch
// and disengages cleanly when they spread apart.
export const PINCH_ENTER_THRESHOLD = 0.085;
export const PINCH_EXIT_THRESHOLD = 0.13;

export const CAMERA_Z_MIN = 1.5;
export const CAMERA_Z_MAX = 12.0;
export const CAMERA_Z_DEFAULT = 5.0;

export const POINTER_PICK_RADIUS_PX = 56;

export const HANDEDNESS_VOTE_WINDOW = 8;
export const ROLE_LOCK_HOLD_FRAMES = 30;

export const TARGET_GRAPH_RADIUS = 2.0;
export const FORCE_SIM_ITERATIONS = 200;
