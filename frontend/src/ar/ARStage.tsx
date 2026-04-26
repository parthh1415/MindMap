import { useEffect, useRef, useState } from "react";
import { useGraphStore, selectNodeList, selectEdgeList } from "@/state/graphStore";
import { useShallow } from "zustand/react/shallow";
import { startWebcam, stopWebcam, describeCameraError } from "./cameraLifecycle";
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

// Mouse-input feel constants — kept inline because they're only used here.
const MOUSE_ROTATE_SENSITIVITY = 0.005;   // radians per pixel of drag
const MOUSE_ZOOM_SENSITIVITY = 0.005;     // camera-Z step per wheel-pixel
const MOUSE_CLICK_DRAG_THRESHOLD = 4;     // px — beyond this, treat as drag not click

interface Props {
  onExit: () => void;
}

export default function ARStage({ onExit }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const graphContainerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("starting…");
  const [inputMode, setInputMode] = useState<"camera" | "mouse">("mouse");
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraTrying, setCameraTrying] = useState(false);
  const { fps, tick, latency } = useFps();

  // Exposed by Effect 1 so the "Retry Camera" button can re-attempt
  // without restarting the scene + RAF loop.
  const retryCameraRef = useRef<(() => Promise<void>) | null>(null);

  const handleRetryCamera = async () => {
    if (cameraTrying) return;
    setCameraTrying(true);
    try {
      await retryCameraRef.current?.();
    } finally {
      setCameraTrying(false);
    }
  };

  const nodes = useGraphStore(useShallow(selectNodeList));
  const edges = useGraphStore(useShallow(selectEdgeList));
  const activatedNodeIds = useGraphStore((s) => s.activatedNodeIds);
  const toggleActivated = useGraphStore((s) => s.toggleActivated);

  // Refs so the RAF loop always reads the latest values without restarting
  const toggleActivatedRef = useRef(toggleActivated);
  useEffect(() => {
    toggleActivatedRef.current = toggleActivated;
  }, [toggleActivated]);

  const activatedRef = useRef(activatedNodeIds);
  useEffect(() => {
    activatedRef.current = activatedNodeIds;
  }, [activatedNodeIds]);

  // Ref so Effect 2 can find the live scene built by Effect 1
  const sceneRef = useRef<SceneRefs | null>(null);

  // Ref to keep tick stable — sync it without causing effect restarts
  const tickRef = useRef(tick);
  useEffect(() => {
    tickRef.current = tick;
  }, [tick]);

  // Effect 1: Build scene + run RAF loop. Only restarts when graph topology changes.
  // Webcam + hand-tracking are best-effort — failure falls back to mouse-only mode.
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

    // Mouse-input state (always wired so users can navigate without a camera)
    let mouseDown = false;
    let mouseDragged = false;
    let lastMouseX = 0;
    let lastMouseY = 0;
    let mouseDownX = 0;
    let mouseDownY = 0;

    // Optional hand-tracking handles (set if webcam + detector come up)
    let handTrackingReady = false;
    type Detector = Awaited<ReturnType<typeof initDetector>>;
    let detector: Detector | null = null;
    let overlayCtx: CanvasRenderingContext2D | null = null;

    const buildSceneFromStore = () => {
      const gc = graphContainerRef.current;
      if (!gc) return false;
      // Defensive filter: drop edges whose endpoints aren't in the
      // current node set. Otherwise d3-force-3d's forceLink throws
      // "node not found: <id>" and the whole AR view dies.
      const nodeIdSet = new Set(nodes.map((n) => n._id));
      const layoutNodes = nodes.map((n) => ({ _id: n._id, label: n.label }));
      const layoutEdges = edges
        .filter(
          (e) => nodeIdSet.has(e.source_id) && nodeIdSet.has(e.target_id),
        )
        .map((e) => ({ source_id: e.source_id, target_id: e.target_id }));
      const droppedEdgeCount = edges.length - layoutEdges.length;
      if (droppedEdgeCount > 0) {
        console.warn(
          `[AR] dropped ${droppedEdgeCount} orphan edge(s) — endpoint id missing from nodes list`,
        );
      }
      const positions = computeLayout(layoutNodes, layoutEdges);
      scene = buildScene(gc, layoutNodes, layoutEdges, positions);
      sceneRef.current = scene;
      return true;
    };

    const setupHandTracking = async (): Promise<void> => {
      // Reset error state on each attempt so the user sees fresh feedback.
      setCameraError(null);
      try {
        const v = videoRef.current;
        const overlay = overlayRef.current;
        if (!v || !overlay) {
          setCameraError("Internal error: video/overlay element missing");
          return;
        }
        stream = await startWebcam(v);
        overlay.width = v.videoWidth || 1280;
        overlay.height = v.videoHeight || 720;
        detector = await initDetector();
        overlayCtx = overlay.getContext("2d");
        handTrackingReady = true;
        setInputMode("camera");
        setCameraError(null);
        setStatus("tracking — pinch (left) to rotate/zoom, pinch (right) on a node to mark");
      } catch (err) {
        console.warn("[AR] camera unavailable:", err);
        // Best-effort cleanup of any partially-acquired resources
        if (stream) {
          stream.getTracks().forEach((t) => t.stop());
          stream = null;
        }
        const v = videoRef.current;
        if (v) v.srcObject = null;
        handTrackingReady = false;
        detector = null;
        overlayCtx = null;
        setInputMode("mouse");
        setCameraError(describeCameraError(err));
        setStatus("waiting for camera — meanwhile drag/scroll/click works");
      }
    };

    // Make setupHandTracking callable from outside the effect (Retry button).
    retryCameraRef.current = setupHandTracking;

    // ── Mouse handlers (attached to the graph container after scene mounts) ──
    const onMouseDown = (e: MouseEvent) => {
      mouseDown = true;
      mouseDragged = false;
      lastMouseX = mouseDownX = e.clientX;
      lastMouseY = mouseDownY = e.clientY;
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!mouseDown) return;
      const dx = e.clientX - lastMouseX;
      const dy = e.clientY - lastMouseY;
      lastMouseX = e.clientX;
      lastMouseY = e.clientY;
      target.yaw += dx * MOUSE_ROTATE_SENSITIVITY;
      target.pitch += dy * MOUSE_ROTATE_SENSITIVITY;
      // Beyond a small threshold, suppress the click-to-activate so a
      // drag doesn't accidentally toggle a node when the cursor lifts.
      if (
        Math.abs(e.clientX - mouseDownX) > MOUSE_CLICK_DRAG_THRESHOLD ||
        Math.abs(e.clientY - mouseDownY) > MOUSE_CLICK_DRAG_THRESHOLD
      ) {
        mouseDragged = true;
      }
    };

    const onMouseUp = (e: MouseEvent) => {
      if (!mouseDown) return;
      mouseDown = false;
      // Click-to-toggle only when the user didn't drag
      if (mouseDragged || !scene) return;
      const target_el = e.currentTarget as HTMLElement;
      const rect = target_el.getBoundingClientRect();
      const fx = e.clientX - rect.left;
      const fy = e.clientY - rect.top;
      let bestId: string | null = null;
      let bestD = POINTER_PICK_RADIUS_PX;
      scene.nodeMeshes.forEach((mesh, id) => {
        const p = projectNodeToScreen(mesh, scene!.camera, rect.width, rect.height);
        const d = Math.hypot(p.x - fx, p.y - fy);
        if (d < bestD) {
          bestD = d;
          bestId = id;
        }
      });
      if (bestId) toggleActivatedRef.current(bestId);
    };

    const onMouseLeave = () => {
      mouseDown = false;
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const dz = e.deltaY * MOUSE_ZOOM_SENSITIVITY;
      target.camZ = Math.min(
        CAMERA_Z_MAX,
        Math.max(CAMERA_Z_MIN, target.camZ + dz),
      );
    };

    // ── Boot sequence ──
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
      // Scene is up; render starts immediately. Webcam is best-effort.
      setStatus("rendering — requesting camera…");

      // Wire mouse handlers to the graph container (and only the container,
      // so clicks on the HUD/exit button still hit those buttons).
      const gc = graphContainerRef.current;
      if (gc) {
        gc.addEventListener("mousedown", onMouseDown);
        gc.addEventListener("mousemove", onMouseMove);
        gc.addEventListener("mouseup", onMouseUp);
        gc.addEventListener("mouseleave", onMouseLeave);
        gc.addEventListener("wheel", onWheel, { passive: false });
      }

      // Start the render+animation loop BEFORE webcam, so the user sees
      // the graph immediately while permission UI is up.
      const loop = async () => {
        if (cancelled) return;
        const t0 = performance.now();

        // Hand-tracking branch — only runs when camera + detector are live.
        if (handTrackingReady && detector && videoRef.current && overlayRef.current) {
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

            // Pointer picking via fingertip
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
                      activatedRef.current.has(highlightedId) ? "active" : "base",
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

            if (overlayCtx) drawHands(overlayCtx, tracks, overlay.width, overlay.height);
          } catch (err) {
            // Don't kill the render loop just because one inference frame failed.
            console.warn("[AR] hand-track frame error:", err);
          }
        }

        // Pose smoothing always runs (driven by mouse OR gestures)
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

      // Now try the camera in parallel — failure is non-fatal.
      await setupHandTracking();
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      const gc = graphContainerRef.current;
      if (gc) {
        gc.removeEventListener("mousedown", onMouseDown);
        gc.removeEventListener("mousemove", onMouseMove);
        gc.removeEventListener("mouseup", onMouseUp);
        gc.removeEventListener("mouseleave", onMouseLeave);
        gc.removeEventListener("wheel", onWheel);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
      if (videoRef.current) stopWebcam(stream, videoRef.current);
      void disposeDetector();
      if (scene) disposeScene(scene);
      sceneRef.current = null;
      clearTrackingState();
    };
  }, [nodes, edges]);

  // Effect 2: Repaint node colors when activatedNodeIds changes — no scene rebuild.
  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    s.nodeMeshes.forEach((mesh, id) => {
      setNodeColor(mesh, activatedNodeIds.has(id) ? "active" : "base");
    });
  }, [activatedNodeIds]);

  return (
    <div className="ar-stage" data-input-mode={inputMode}>
      <video ref={videoRef} playsInline muted />
      <div ref={graphContainerRef} className="ar-graph" />
      <canvas ref={overlayRef} className="ar-overlay" />
      <div className="ar-hud">
        <span>{status}</span>
        <span>{fps} fps</span>
        <span>{latency.toFixed(0)} ms</span>
        <span>nodes {nodes.length}</span>
        <span>active {activatedNodeIds.size}</span>
      </div>
      {inputMode === "mouse" ? (
        <div className="ar-camera-banner" role="status">
          {cameraError ? (
            <p className="ar-camera-error">{cameraError}</p>
          ) : (
            <p className="ar-camera-hint">
              Click below to enable hand-tracking with your camera. Two-hand
              gestures: pinch left to rotate/zoom, pinch right on a node to mark.
            </p>
          )}
          <button
            type="button"
            className="ar-camera-retry"
            onClick={handleRetryCamera}
            disabled={cameraTrying}
          >
            {cameraTrying
              ? "Trying camera…"
              : cameraError
                ? "Retry Camera"
                : "Enable Camera"}
          </button>
        </div>
      ) : null}
      <button className="ar-exit" onClick={onExit}>Exit AR</button>
    </div>
  );
}
