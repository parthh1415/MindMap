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
  updateAnimations,
  updateEdgePositions,
  captureCurrentPositions,
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

type Detector = Awaited<ReturnType<typeof initDetector>>;

/**
 * Hands-only AR view.
 *
 * Architecture:
 *  - CameraEffect (mount-only): set up webcam + detector. Survives graph
 *    changes so we don't re-prompt for permission every time a new node
 *    arrives during live recording.
 *  - SceneEffect ([nodes, edges]): build the 3D scene from the live
 *    graphStore. Disposes + rebuilds when the graph topology changes.
 *  - RafEffect (mount-only): single render + gesture loop. Reads scene
 *    and detector from refs so it never restarts.
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
  const [handsDebug, setHandsDebug] = useState<string>("hands: 0");
  const { fps, tick, latency } = useFps();

  const nodes = useGraphStore(useShallow(selectNodeList));
  const edges = useGraphStore(useShallow(selectEdgeList));
  const activatedNodeIds = useGraphStore((s) => s.activatedNodeIds);
  const toggleActivated = useGraphStore((s) => s.toggleActivated);

  // ── Refs read by the persistent RAF loop ──
  const detectorRef = useRef<Detector | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sceneRef = useRef<SceneRefs | null>(null);
  // Positions cache — preserves orb positions across scene rebuilds so
  // existing orbs don't jump back to center every time a new node
  // arrives mid-session. Newly-added orb ids that aren't in this Map
  // bloom from (0,0,0). Updated on dispose, used on next build.
  const knownPositionsRef = useRef<Map<string, THREE.Vector3>>(new Map());
  const overlayCtxRef = useRef<CanvasRenderingContext2D | null>(null);

  const toggleActivatedRef = useRef(toggleActivated);
  useEffect(() => {
    toggleActivatedRef.current = toggleActivated;
  }, [toggleActivated]);

  const activatedRef = useRef(activatedNodeIds);
  useEffect(() => {
    activatedRef.current = activatedNodeIds;
  }, [activatedNodeIds]);

  const tickRef = useRef(tick);
  useEffect(() => {
    tickRef.current = tick;
  }, [tick]);

  // ── Camera setup, exposed via refs so a Retry / Switch button can
  // call them without re-running the mount effect. ──
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

  // ── CameraEffect: mount-only setup of webcam + detector. ──
  useEffect(() => {
    let cancelled = false;

    const setupHandTracking = async (
      requestedDeviceId?: string | null,
    ): Promise<void> => {
      if (cancelled) return;
      setCameraError(null);
      try {
        const v = videoRef.current;
        const overlay = overlayRef.current;
        if (!v || !overlay) {
          setCameraError("Internal error: video/overlay element missing");
          return;
        }

        // First grant — request preferred device if known, else
        // facingMode hint. We re-pick after enumeration.
        const preferredId = requestedDeviceId ?? getPreferredCameraId();
        let stream = await startWebcam(v, preferredId);
        streamRef.current = stream;

        const list = await listCameras();
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        setCameras(list);

        const currentTrack = stream.getVideoTracks()[0];
        const currentDeviceId = currentTrack?.getSettings().deviceId ?? null;
        const targetCam = pickCamera(list, preferredId ?? currentDeviceId);

        if (
          targetCam &&
          currentDeviceId &&
          targetCam.deviceId !== currentDeviceId
        ) {
          stream.getTracks().forEach((t) => t.stop());
          stream = await startWebcam(v, targetCam.deviceId);
          streamRef.current = stream;
          setPreferredCameraId(targetCam.deviceId);
          setActiveCameraId(targetCam.deviceId);
        } else {
          setActiveCameraId(currentDeviceId ?? targetCam?.deviceId ?? null);
          if (targetCam) setPreferredCameraId(targetCam.deviceId);
        }

        if (cancelled) return;
        overlay.width = v.videoWidth || 1920;
        overlay.height = v.videoHeight || 1080;
        const detector = await initDetector();
        if (cancelled) {
          detector.dispose();
          return;
        }
        detectorRef.current = detector;
        overlayCtxRef.current = overlay.getContext("2d");
        setCameraReady(true);
        setCameraError(null);
        setStatus(
          "tracking — left pinch rotates/zooms, right pinch on a node marks",
        );
      } catch (err) {
        console.warn("[AR] camera unavailable:", err);
        const s = streamRef.current;
        if (s) {
          s.getTracks().forEach((t) => t.stop());
          streamRef.current = null;
        }
        const v = videoRef.current;
        if (v) v.srcObject = null;
        detectorRef.current = null;
        overlayCtxRef.current = null;
        setCameraReady(false);
        setCameraError(describeCameraError(err));
        setStatus("camera blocked — tap anywhere to enable hand tracking");
      }
    };

    retryCameraRef.current = () => setupHandTracking();
    switchCameraRef.current = async (deviceId: string) => {
      const s = streamRef.current;
      if (s) {
        s.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      const v = videoRef.current;
      if (v) v.srcObject = null;
      detectorRef.current = null;
      overlayCtxRef.current = null;
      await disposeDetector();
      await setupHandTracking(deviceId);
    };

    // Auto-attempt: if the browser already granted permission, this
    // returns the stream silently with no prompt. If not (cached deny,
    // first visit, gesture-required), it throws and the tap-target
    // overlay shows. Either way no flash.
    void setupHandTracking();

    return () => {
      cancelled = true;
      const s = streamRef.current;
      const v = videoRef.current;
      if (v) stopWebcam(s, v);
      streamRef.current = null;
      detectorRef.current = null;
      overlayCtxRef.current = null;
      void disposeDetector();
      clearTrackingState();
    };
  }, []);

  // ── SceneEffect: rebuild the 3D scene whenever the live graph
  // changes. Camera + detector untouched. ──
  useEffect(() => {
    if (nodes.length === 0) {
      setStatus(
        cameraReady
          ? "no nodes yet — start talking to generate orbs"
          : "no nodes yet — start talking",
      );
      return;
    }
    const gc = graphContainerRef.current;
    if (!gc) return;

    // Defensive filter — drop edges whose endpoints aren't in the
    // node set (otherwise d3-force-3d throws "node not found: <id>").
    const nodeIdSet = new Set(nodes.map((n) => n._id));
    const layoutNodes = nodes.map((n) => ({ _id: n._id, label: n.label }));
    const layoutEdges = edges
      .filter((e) => nodeIdSet.has(e.source_id) && nodeIdSet.has(e.target_id))
      .map((e) => ({ source_id: e.source_id, target_id: e.target_id }));

    const positions = computeLayout(layoutNodes, layoutEdges);
    // Build using the previous-known-positions cache. Existing orbs
    // resume where they left off; new orbs bloom from (0,0,0).
    const scene = buildScene(
      gc,
      layoutNodes,
      layoutEdges,
      positions,
      knownPositionsRef.current,
    );
    sceneRef.current = scene;

    return () => {
      // Snapshot the orbs' current positions BEFORE disposing so the
      // next rebuild (e.g., when a new node arrives) preserves them.
      knownPositionsRef.current = captureCurrentPositions(scene);
      disposeScene(scene);
      sceneRef.current = null;
    };
    // We intentionally exclude cameraReady — the SceneEffect is
    // independent of camera state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges]);

  // ── RafEffect: persistent render + gesture loop. Reads everything
  // from refs so it never restarts. Mouse is the primary control;
  // gestures are additive — both feed into the same target pose. If
  // hand tracking is flaky, mouse keeps the view fully usable. ──
  useEffect(() => {
    let raf = 0;
    let cancelled = false;
    let tracks: TrackedHand[] = [];
    const gesture = createGestureController();

    const target = { yaw: 0, pitch: 0, camZ: CAMERA_Z_DEFAULT };
    const current = { yaw: 0, pitch: 0, camZ: CAMERA_Z_DEFAULT };
    let highlightedId: string | null = null;
    let debugFrameCounter = 0;

    // ── Mouse handlers (always wired — primary control) ──
    let mouseDown = false;
    let mouseDragged = false;
    let lastMouseX = 0;
    let lastMouseY = 0;
    let mouseDownX = 0;
    let mouseDownY = 0;
    const MOUSE_ROTATE = 0.005;
    const MOUSE_ZOOM = 0.005;
    const CLICK_DRAG_THRESHOLD = 4;

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
      target.yaw += dx * MOUSE_ROTATE;
      target.pitch += dy * MOUSE_ROTATE;
      if (
        Math.abs(e.clientX - mouseDownX) > CLICK_DRAG_THRESHOLD ||
        Math.abs(e.clientY - mouseDownY) > CLICK_DRAG_THRESHOLD
      ) {
        mouseDragged = true;
      }
    };
    const onMouseUp = (e: MouseEvent) => {
      if (!mouseDown) return;
      mouseDown = false;
      const scene = sceneRef.current;
      if (mouseDragged || !scene) return;
      const el = e.currentTarget as HTMLElement;
      const rect = el.getBoundingClientRect();
      const fx = e.clientX - rect.left;
      const fy = e.clientY - rect.top;
      let bestId: string | null = null;
      let bestD = POINTER_PICK_RADIUS_PX;
      scene.nodeMeshes.forEach((mesh, id) => {
        const p = projectNodeToScreen(mesh, scene.camera, rect.width, rect.height);
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
      const dz = e.deltaY * MOUSE_ZOOM;
      target.camZ = Math.min(
        CAMERA_Z_MAX,
        Math.max(CAMERA_Z_MIN, target.camZ + dz),
      );
    };

    const gc = graphContainerRef.current;
    if (gc) {
      gc.addEventListener("mousedown", onMouseDown);
      gc.addEventListener("mousemove", onMouseMove);
      gc.addEventListener("mouseup", onMouseUp);
      gc.addEventListener("mouseleave", onMouseLeave);
      gc.addEventListener("wheel", onWheel, { passive: false });
    }

    const loop = async () => {
      if (cancelled) return;
      const t0 = performance.now();
      const detector = detectorRef.current;
      const v = videoRef.current;
      const overlay = overlayRef.current;
      const overlayCtx = overlayCtxRef.current;
      const scene = sceneRef.current;

      if (detector && v && overlay && v.readyState >= 2) {
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
            // Overlay is mirrored via CSS scaleX(-1); fingertip needs mirror.
            const fx = w - frame.pointerScreen.x;
            const fy = frame.pointerScreen.y;
            let bestId: string | null = null;
            let bestD = POINTER_PICK_RADIUS_PX;
            scene.nodeMeshes.forEach((mesh, id) => {
              const p = projectNodeToScreen(mesh, scene.camera, w, h);
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

          debugFrameCounter++;
          if (debugFrameCounter % 6 === 0) {
            const lines = tracks.map((t) => {
              const role = t.role ?? "?";
              const pinch = t.isPinched
                ? "PINCH"
                : `${t.pinchStrength.toFixed(2)}`;
              return `${role}:${pinch}`;
            });
            setHandsDebug(
              tracks.length === 0
                ? "hands: 0"
                : `hands: ${tracks.length} ${lines.join(" ")}`,
            );
          }
        } catch (err) {
          console.warn("[AR] hand-track frame error:", err);
        }
      }

      // Pose smoothing always runs (slowly settles into target pose).
      current.yaw += (target.yaw - current.yaw) * ROTATION_DAMPING;
      current.pitch += (target.pitch - current.pitch) * ROTATION_DAMPING;
      current.camZ += (target.camZ - current.camZ) * ZOOM_CAMERA_DAMPING;

      if (scene) {
        // Step the bloom-from-center spring physics. Rewrite the edge
        // line buffer ONLY while orbs are still in motion — once the
        // constellation has settled there's nothing to redraw.
        const stillBlooming = updateAnimations(scene);
        if (stillBlooming) updateEdgePositions(scene);

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

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      const gcCleanup = graphContainerRef.current;
      if (gcCleanup) {
        gcCleanup.removeEventListener("mousedown", onMouseDown);
        gcCleanup.removeEventListener("mousemove", onMouseMove);
        gcCleanup.removeEventListener("mouseup", onMouseUp);
        gcCleanup.removeEventListener("mouseleave", onMouseLeave);
        gcCleanup.removeEventListener("wheel", onWheel);
      }
    };
  }, []);

  // Repaint node colors when activatedNodeIds changes.
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
        <span>{handsDebug}</span>
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
                {c.label}{" "}
                {c.kind === "continuity"
                  ? "(iPhone)"
                  : c.kind === "builtin"
                    ? "(built-in)"
                    : ""}
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
