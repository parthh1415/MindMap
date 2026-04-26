// All physics/feel constants in one place. Adjust here, never inline.

export const SMOOTHING_ALPHA = 0.5;
export const TRACK_MATCH_MAX_DISTANCE = 0.25;

export const ROTATE_SENSITIVITY = 0.018;
export const ROTATION_DAMPING = 0.22;

export const ZOOM_DEPTH_SENSITIVITY = 14.0;
export const ZOOM_DEPTH_THRESHOLD = 0.0015;
export const DEPTH_DAMPING = 0.55;
export const MAX_ZOOM_STEP = 0.8;
export const ZOOM_CAMERA_DAMPING = 0.15;

// Pinch detection uses (thumb-tip ↔ index-tip distance) / palm-span.
// Original 0.045 / 0.06 was too tight — fingertips had to almost
// touch for the model to register, and MediaPipe's confidence dips
// at the edges of the frame meant pinches were dropped intermittently.
// 0.085 / 0.13 gives a forgiving "pinch shape" that activates well
// before fingertips touch and disengages cleanly when they spread.
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
