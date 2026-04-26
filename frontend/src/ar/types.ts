// Domain types for AR. No imports from three/tfjs to keep this lightweight.

export type Role = "control" | "pointer";

export interface Vec2 { x: number; y: number; }
export interface Vec3 { x: number; y: number; z: number; }

export interface Landmark extends Vec3 {}

export interface RawHand {
  handedness: "Left" | "Right";
  score: number;
  keypoints: Landmark[];          // 21 landmarks, image-pixel x/y, normalized z
  keypoints3D?: Landmark[];
}

export interface TrackedHand {
  trackId: string;                 // stable id across frames
  role: Role | null;               // resolved after handedness voting
  smoothed: Landmark[];            // EMA-smoothed 21 landmarks
  centroid: Vec2;
  palmSpan: number;
  pinchStrength: number;           // 0..1, distance ratio
  isPinched: boolean;              // hysteresis state
  framesSinceSeen: number;
}

export interface GraphNode3D {
  _id: string;
  label: string;
  position: Vec3;                  // post-d3-force-3d, normalized into TARGET_GRAPH_RADIUS
}

export interface GraphEdge3D {
  source_id: string;
  target_id: string;
}

export interface GraphPose {
  yaw: number;
  pitch: number;
}

export interface GestureFrame {
  rotateDelta: { yaw: number; pitch: number } | null;
  zoomDelta: number | null;
  pointerScreen: Vec2 | null;        // overlay-pixel coords of pointer fingertip
  pointerPinchEdge: "down" | "up" | null;  // edge-triggered, fires once per pinch
}
