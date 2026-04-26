import { useEffect, useRef, useState } from "react";
import { useGraphStore, selectNodeList, selectEdgeList } from "@/state/graphStore";
import { useShallow } from "zustand/react/shallow";
import {
  startWebcam,
  stopWebcam,
  describeCameraError,
  listCameras,
  getPreferredCameraId,
  setPreferredCameraId,
  pickCamera,
  type CameraInfo,
} from "./cameraLifecycle";
import {
  initDetector,
  disposeDetector,
  matchTracks,
  resolveRoles,
  clearTrackingState,
} from "./handTracking";
import { createGestureController } from "./gestureControls";
import {
  computeLayout,
  buildScene,
  disposeScene,
  setNodeColor,
  projectNodeToScreen,
  type SceneRefs,
} from "./graph3d";
import { drawHands } from "./handDrawing";
import { useFps } from "./useFps";
import {
  CAMERA_Z_DEFAULT, CAMERA_Z_MIN, CAMERA_Z_MAX,
  ROTATION_DAMPING, ZOOM_CAMERA_DAMPING, POINTER_PICK_RADIUS_PX,
} from "./tunables";
import type { TrackedHand, RawHand } from "./types";
import * as THREE from "three";
import "./ARStage.css";

interface Props {
  onExit: () => void;
}

/**
 * Hands-only AR view per the reference spec:
 *   - Opens webcam feed in real time
 *   - Tracks hands via @mediapipe/hands (local assets, no TFHub fetch)
 *   - Renders the live graph in a WebGL overlay
 *   - Left hand pinch  = clutch → wrist Δ rotates yaw/pitch, depth Δ zooms
 *   - Right hand pinch = pointer → index fingertip picks node, pinch toggles
 *   - graph container has pointer-events: none — no mouse input
 *
 * If the camera can't start (cached deny, gesture-required, busy), the
 * full stage becomes a tap-target: clicking anywhere re-attempts the
 * permission flow. No "retry" button — the entire screen IS the button.
 */
export default function ARStage({ onExit }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const graphContainerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("starting…");
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraTrying, setCameraTrying] = useState(false);
  const [cameras, setCameras] = useState<CameraInfo[]>([]);
  const [activeCameraId, setActiveCameraId] = useState<string | null>(null);
  const { fps, tick, latency } = useFps();

  const nodes = useGraphStore(useShallow(selectNodeList));
  const edges = useGraphStore(useShallow(selectEdgeList));
  const activatedNodeIds = useGraphStore((s) => s.activatedNodeIds);
  const toggleActivated = useGraphStore((s) => s.toggleActivated);

  // Refs so the RAF loop reads the latest values without restarting
  const toggleActivatedRef = useRef(toggleActivated);
  useEffect(() => {
    toggleActivatedRef.current = toggleActivated;
  }, [toggleActivated]);

  const activatedRef = useRef(activatedNodeIds);
  useEffect(() => {
    activatedRef.current = activatedNodeIds;
  }, [activatedNodeIds]);

  const sceneRef = useRef<SceneRefs | null>(null);

  const tickRef = useRef(tick);
  useEffect(() => {
    tickRef.current = tick;
  }, [tick]);

  // Exposed by Effect 1; called from the fullscreen tap-target + the
  // camera-picker dropdown in JSX.
  const retryCameraRef = useRef<(() => Promise<void>) | null>(null);
  const switchCameraRef = useRef<((id: string) => Promise<void>) | null>(null);

  const handleTapToEnable = async () => {
    if (cameraTrying || cameraReady) return;
    setCameraTrying(true);
    try {
      await retryCameraRef.current?.();
    } finally {
      setCameraTrying(false);
    }
  };

  const handlePickCamera = async (deviceId: string) => {
    if (cameraTrying) return;
    setPreferredCameraId(deviceId);
    setCameraTrying(true);
    try {
      await switchCameraRef.current?.(deviceId);
    } finally {
      setCameraTrying(false);
    }
  };

  // Effect 1: build scene, set up camera + hand tracking, run RAF loop.
  // Restarts only when graph topology changes (nodes/edges).
  useEffect(() => {
    let raf = 0;
    let stream: MediaStream | null = null;
    let scene: SceneRefs | null = null;
    let cancelled = false;
    let tracks: TrackedHand[] = [];
    const gesture = createGestureController();

    const target = { yaw: 0, pitch: 0, camZ: CAMERA_Z_DEFAULT };
    const current = { yaw: 0, pitch: 0, camZ: CAMERA_Z_DEFAULT };
    let highlightedId: string | null = null;

    let handTrackingReady = false;
    type Detector = Awaited<ReturnType<typeof initDetector>>;
    let detector: Detector | null = null;
    let overlayCtx: CanvasRenderingContext2D | null = null;

    const buildSceneFromStore = () => {
      const gc = graphContainerRef.current;
      if (!gc) return false;
      // Defensive filter — drop edges whose endpoints aren't in the
      // node set (otherwise d3-force-3d throws "node not found: <id>").
      const nodeIdSet = new Set(nodes.map((n) => n._id));
      const layoutNodes = nodes.map((n) => ({ _id: n._id, label: n.label }));
      const layoutEdges = edges
        .filter(
          (e) => nodeIdSet.has(e.source_id) && nodeIdSet.has(e.target_id),
        )
        .map((e) => ({ source_id: e.source_id, target_id: e.target_id }));
      const dropped = edges.length - layoutEdges.length;
      if (dropped > 0) {
        console.warn(
          `[AR] dropped ${dropped} orphan edge(s) — endpoint id missing from nodes list`,
        );
      }
      const positions = computeLayout(layoutNodes, layoutEdges);
      scene = buildScene(gc, layoutNodes, layoutEdges, positions);
      sceneRef.current = scene;
      return true;
    };

    const setupHandTracking = async (
      requestedDeviceId?: string | null,
    ): Promise<void> => {
      setCameraError(null);
      try {
        const v = videoRef.current;
        const overlay = overlayRef.current;
        if (!v || !overlay) {
          setCameraError("Internal error: video/overlay element missing");
          return;
        }

        // 1. Initial grant — request with explicit deviceId if known,
        //    otherwise facingMode hint. macOS often picks Continuity
        //    Camera (your iPhone) over the built-in webcam, which is
        //    almost never what the user wants for AR.
        const preferredId = requestedDeviceId ?? getPreferredCameraId();
        stream = await startWebcam(v, preferredId);

        // 2. Once permission is granted, labels become readable.
        //    Enumerate, classify, and auto-switch if we landed on
        //    Continuity but a built-in / external camera exists.
        const list = await listCameras();
        setCameras(list);

        const currentTrack = stream.getVideoTracks()[0];
        const currentDeviceId = currentTrack?.getSettings().deviceId ?? null;
        const targetCam = pickCamera(list, preferredId ?? currentDeviceId);

        if (
          targetCam &&
          currentDeviceId &&
          targetCam.deviceId !== currentDeviceId
        ) {
          // We're on the wrong camera — restart with the right one.
          stream.getTracks().forEach((t) => t.stop());
          stream = await startWebcam(v, targetCam.deviceId);
          setPreferredCameraId(targetCam.deviceId);
          setActiveCameraId(targetCam.deviceId);
        } else {
          setActiveCameraId(currentDeviceId ?? targetCam?.deviceId ?? null);
          // Persist whichever we settled on so next session is
          // deterministic.
          if (targetCam) setPreferredCameraId(targetCam.deviceId);
        }

        overlay.width = v.videoWidth || 1280;
        overlay.height = v.videoHeight || 720;
        detector = await initDetector();
        overlayCtx = overlay.getContext("2d");
        handTrackingReady = true;
        setCameraReady(true);
        setCameraError(null);
        setStatus(
          "tracking — left pinch rotates/zooms, right pinch on a node marks",
        );
      } catch (err) {
        console.warn("[AR] camera unavailable:", err);
        if (stream) {
          stream.getTracks().forEach((t) => t.stop());
          stream = null;
        }
        const v = videoRef.current;
        if (v) v.srcObject = null;
        handTrackingReady = false;
        detector = null;
        overlayCtx = null;
        setCameraReady(false);
        setCameraError(describeCameraError(err));
        setStatus("camera blocked — tap anywhere to enable hand tracking");
      }
    };
    retryCameraRef.current = () => setupHandTracking();
    switchCameraRef.current = async (deviceId: string) => {
      // Tear down the current stream + detector first so the new
      // device gets fresh state.
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
        stream = null;
      }
      const v = videoRef.current;
      if (v) v.srcObject = null;
      handTrackingReady = false;
      detector = null;
      overlayCtx = null;
      await disposeDetector();
      await setupHandTracking(deviceId);
    };

    (async () => {
      if (cancelled) return;
      if (nodes.length === 0) {
        setStatus("no nodes — run a session first");
        return;
      }
      if (!buildSceneFromStore()) {
        setStatus("error: graph container missing");
        return;
      }
      setStatus("rendering — requesting camera…");

      // Render loop runs unconditionally so the user always sees the
      // graph spinning slowly at the smoothed pose. Hand-tracking
      // augments it when the camera is up.
      const loop = async () => {
        if (cancelled) return;
        const t0 = performance.now();

        if (
          handTrackingReady &&
          detector &&
          videoRef.current &&
          overlayRef.current
        ) {
          const v = videoRef.current;
          const overlay = overlayRef.current;
          try {
            const raw = (await detector.estimateHands(v, {
              flipHorizontal: false,
              staticImageMode: false,
            })) as RawHand[];

            tracks = matchTracks(tracks, raw, v.videoWidth, v.videoHeight);
            const rawByTrack = new Map<string, RawHand>();
            for (let i = 0; i < tracks.length && i < raw.length; i++) {
              rawByTrack.set(tracks[i]!.trackId, raw[i]!);
            }
            tracks = resolveRoles(tracks, rawByTrack);

            const frame = gesture.update(tracks);
            if (frame.rotateDelta) {
              target.yaw += frame.rotateDelta.yaw;
              target.pitch += frame.rotateDelta.pitch;
            }
            if (frame.zoomDelta != null) {
              target.camZ = Math.min(
                CAMERA_Z_MAX,
                Math.max(CAMERA_Z_MIN, target.camZ + frame.zoomDelta),
              );
            }

            if (scene && frame.pointerScreen) {
              const w = overlay.width;
              const h = overlay.height;
              // Mirror correction — overlay is flipped via CSS scaleX(-1)
              const fx = w - frame.pointerScreen.x;
              const fy = frame.pointerScreen.y;
              let bestId: string | null = null;
              let bestD = POINTER_PICK_RADIUS_PX;
              scene.nodeMeshes.forEach((mesh, id) => {
                const p = projectNodeToScreen(mesh, scene!.camera, w, h);
                const d = Math.hypot(p.x - fx, p.y - fy);
                if (d < bestD) {
                  bestD = d;
                  bestId = id;
                }
              });

              if (bestId !== highlightedId) {
                if (highlightedId) {
                  const prev = scene.nodeMeshes.get(highlightedId);
                  if (prev)
                    setNodeColor(
                      prev,
                      activatedRef.current.has(highlightedId)
                        ? "active"
                        : "base",
                    );
                }
                if (bestId) {
                  const m = scene.nodeMeshes.get(bestId);
                  if (m) setNodeColor(m, "hover");
                }
                highlightedId = bestId;
              }
            }

            if (frame.pointerPinchEdge === "down" && highlightedId) {
              toggleActivatedRef.current(highlightedId);
            }

            if (overlayCtx)
              drawHands(overlayCtx, tracks, overlay.width, overlay.height);
          } catch (err) {
            console.warn("[AR] hand-track frame error:", err);
          }
        }

        // Pose smoothing (driven only by gestures — no mouse input)
        current.yaw += (target.yaw - current.yaw) * ROTATION_DAMPING;
        current.pitch += (target.pitch - current.pitch) * ROTATION_DAMPING;
        current.camZ += (target.camZ - current.camZ) * ZOOM_CAMERA_DAMPING;

        if (scene) {
          const eul = new THREE.Euler(current.pitch, current.yaw, 0, "YXZ");
          scene.graphRoot.quaternion.setFromEuler(eul);
          scene.camera.position.z = current.camZ;
          scene.camera.lookAt(0, 0, 0);
          scene.renderer.render(scene.scene, scene.camera);
        }

        tickRef.current(performance.now() - t0);
        raf = requestAnimationFrame(loop);
      };
      loop();

      // Try the camera in parallel — if it fails, the JSX shows the
      // tap-anywhere overlay that calls retryCameraRef on click.
      await setupHandTracking();
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      // eslint-disable-next-line react-hooks/exhaustive-deps
      if (videoRef.current) stopWebcam(stream, videoRef.current);
      void disposeDetector();
      if (scene) disposeScene(scene);
      sceneRef.current = null;
      clearTrackingState();
    };
  }, [nodes, edges]);

  // Effect 2: repaint node colors when activatedNodeIds changes.
  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    s.nodeMeshes.forEach((mesh, id) => {
      setNodeColor(mesh, activatedNodeIds.has(id) ? "active" : "base");
    });
  }, [activatedNodeIds]);

  return (
    <div className="ar-stage">
      <video ref={videoRef} playsInline muted />
      <div ref={graphContainerRef} className="ar-graph" />
      <canvas ref={overlayRef} className="ar-overlay" />
      <div className="ar-hud">
        <span>{status}</span>
        <span>{fps} fps</span>
        <span>{latency.toFixed(0)} ms</span>
        <span>nodes {nodes.length}</span>
        <span>active {activatedNodeIds.size}</span>
        {cameras.length > 1 && cameraReady ? (
          <select
            className="ar-camera-picker"
            value={activeCameraId ?? ""}
            disabled={cameraTrying}
            onChange={(e) => void handlePickCamera(e.target.value)}
            aria-label="Switch camera"
          >
            {cameras.map((c) => (
              <option key={c.deviceId} value={c.deviceId}>
                {c.label} {c.kind === "continuity" ? "(iPhone)" : c.kind === "builtin" ? "(built-in)" : ""}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      {!cameraReady ? (
        <button
          type="button"
          className="ar-tap-target"
          onClick={handleTapToEnable}
          disabled={cameraTrying}
          aria-label="Tap anywhere to enable camera and hand tracking"
        >
          <div className="ar-tap-card">
            <h2>{cameraTrying ? "Connecting camera…" : "Tap to enable hand tracking"}</h2>
            {cameraError ? (
              <p className="ar-tap-error">{cameraError}</p>
            ) : (
              <p>
                Two-hand gestures: <strong>left pinch</strong> rotates &amp; zooms,
                <strong> right pinch</strong> on a node toggles activation.
              </p>
            )}
          </div>
        </button>
      ) : null}
      <button className="ar-exit" onClick={onExit}>Exit AR</button>
    </div>
  );
}
