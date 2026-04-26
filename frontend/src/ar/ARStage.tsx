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
  updateLabelVisibility,
  captureCurrentPositions,
  type SceneRefs,
} from "./graph3d";
import { drawHands } from "./handDrawing";
import { useFps } from "./useFps";
import {
  CAMERA_Z_DEFAULT, CAMERA_Z_MIN, CAMERA_Z_MAX,
  ROTATION_DAMPING, ZOOM_CAMERA_DAMPING, POINTER_PICK_RADIUS_PX,
} from "./tunables";
import type { TrackedHand, RawHand, Vec2 } from "./types";
import * as THREE from "three";
import { useArSettingsStore } from "@/state/arSettingsStore";
import { useArContextStore } from "@/state/arContextStore";
import NodeContextCardHost from "./NodeContextCardHost";
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
  // Stage size for the card host's flip-side / clamp logic. Updated on
  // resize; the cards re-evaluate their side when the box changes.
  const [stageSize, setStageSize] = useState<{ w: number; h: number }>(() => ({
    w: typeof window !== "undefined" ? window.innerWidth : 1280,
    h: typeof window !== "undefined" ? window.innerHeight : 720,
  }));
  useEffect(() => {
    const onResize = () =>
      setStageSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const { fps, tick, latency } = useFps();

  const nodes = useGraphStore(useShallow(selectNodeList));
  const edges = useGraphStore(useShallow(selectEdgeList));
  const speakerColors = useGraphStore((s) => s.speakerColors);
  const activatedNodeIds = useGraphStore((s) => s.activatedNodeIds);
  const toggleActivated = useGraphStore((s) => s.toggleActivated);

  // AR settings + context cards. The toggle persists in localStorage so
  // the user's pinch preference survives reloads.
  const expandOnPinch = useArSettingsStore((s) => s.expandOnPinch);
  const toggleExpandOnPinch = useArSettingsStore((s) => s.toggleExpandOnPinch);
  const toggleCard = useArContextStore((s) => s.toggleCard);
  const closeAllCards = useArContextStore((s) => s.closeAll);

  // ── Refs read by the persistent RAF loop ──
  const detectorRef = useRef<Detector | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sceneRef = useRef<SceneRefs | null>(null);
  // Positions cache — preserves orb positions across scene rebuilds so
  // existing orbs don't jump back to center every time a new node
  // arrives mid-session. Newly-added orb ids that aren't in this Map
  // bloom from (0,0,0). Updated on dispose, used on next build.
  const knownPositionsRef = useRef<Map<string, THREE.Vector3>>(new Map());
  // Live projected pixel positions of every node — written every RAF
  // tick after pointer pick. NodeContextCardHost reads this to keep
  // open cards anchored to their orbs as the constellation rotates.
  const cardAnchorsRef = useRef<Map<string, Vec2>>(new Map());
  // Latest gesture refs — used by the RAF loop. They're refs so the
  // loop never restarts when a setting flips.
  const expandOnPinchRef = useRef(expandOnPinch);
  useEffect(() => {
    expandOnPinchRef.current = expandOnPinch;
  }, [expandOnPinch]);
  const toggleCardRef = useRef(toggleCard);
  useEffect(() => {
    toggleCardRef.current = toggleCard;
  }, [toggleCard]);
  // Cinematic gate: hold the constellation collapsed at the origin
  // until the camera is first granted. The very first build after
  // cameraReady flips true clears knownPositionsRef so EVERY orb
  // starts at (0,0,0) and unfolds outward — the "permission granted →
  // unfold" beat the user wants. After that one cinematic build, the
  // ref toggles permanent and rebuilds preserve positions normally.
  const sceneUnsealedRef = useRef(false);
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
      isAutoAttempt = false,
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
        // On a silent auto-attempt (no user gesture yet) we never show
        // an error — the tap-target overlay reads as a clean "Tap to
        // enable" call to action. Errors only surface after the user
        // has actually tried (Retry / tap), so the message reflects a
        // real failure rather than a browser-policy abort.
        if (!isAutoAttempt) {
          setCameraError(describeCameraError(err));
          setStatus("camera blocked — tap anywhere to enable hand tracking");
        } else {
          setStatus("tap to enable hand tracking");
        }
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

    // Only auto-attempt when the browser already has permission cached
    // as 'granted'. Otherwise getUserMedia fires from a non-user-gesture
    // context (React effect on mount), which Safari + others reject with
    // AbortError BEFORE the user has any chance to interact — that's
    // what produced the spooky "Camera request was aborted" banner on
    // first visit. With the gate, the tap-target shows cleanly until
    // the user actually taps; the tap IS a user gesture, so the real
    // first attempt always succeeds.
    void (async () => {
      try {
        const perms = (navigator as Navigator & {
          permissions?: { query?: (q: { name: string }) => Promise<PermissionStatus> };
        }).permissions;
        if (perms?.query) {
          const status = await perms.query({ name: "camera" });
          if (cancelled) return;
          if (status.state === "granted") {
            await setupHandTracking(null, true);
          } else {
            setStatus("tap to enable hand tracking");
          }
          return;
        }
      } catch {
        // permissions.query unsupported or threw (Safari quirks) —
        // fall through to a silent best-effort attempt.
      }
      if (!cancelled) await setupHandTracking(null, true);
    })();

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
  // changes — but hold the FIRST build until cameraReady so the
  // constellation visibly unfolds the moment the camera lights up. ──
  useEffect(() => {
    if (nodes.length === 0) {
      setStatus(
        cameraReady
          ? "no nodes yet — start talking to generate orbs"
          : "no nodes yet — start talking",
      );
      return;
    }
    // Pre-camera gate: don't build the scene yet. Nodes will sit in
    // the store; once camera flips ready we reset positions and the
    // whole constellation blooms outward in one cinematic moment.
    if (!cameraReady && !sceneUnsealedRef.current) {
      setStatus("orbs will unfold when camera is ready…");
      return;
    }
    const gc = graphContainerRef.current;
    if (!gc) return;

    // First build after camera grant → wipe known positions so every
    // existing orb starts at (0,0,0) and springs out together. After
    // this one cinematic build, sceneUnsealedRef is true and rebuilds
    // (e.g. when new nodes arrive) preserve positions normally.
    //
    // Important: the ref ONLY flips to `true` after `doBuild` actually
    // mounts the scene. Otherwise this race shows up: nodes change
    // during the 380 ms unfold delay → cleanup clears the timer → the
    // re-run sees `sceneUnsealedRef = true` and skips the unfold path,
    // even though no scene ever rendered. Result: orbs flash in at the
    // wrong positions (or briefly not at all).
    const isUnfoldBuild = !sceneUnsealedRef.current;
    if (isUnfoldBuild) {
      knownPositionsRef.current = new Map();
    }

    // Defensive filter — drop edges whose endpoints aren't in the
    // node set (otherwise d3-force-3d throws "node not found: <id>").
    const nodeIdSet = new Set(nodes.map((n) => n._id));
    const layoutNodes = nodes.map((n) => ({
      _id: n._id,
      label: n.label,
      // importance_score from the topology agent — drives orb size.
      // Defaults to 0.5 (mid-tier) if the agent didn't set one.
      importance: n.importance_score ?? 0.5,
    }));
    const layoutEdges = edges
      .filter((e) => nodeIdSet.has(e.source_id) && nodeIdSet.has(e.target_id))
      .map((e) => ({ source_id: e.source_id, target_id: e.target_id }));

    const positions = computeLayout(layoutNodes, layoutEdges);

    // For the unfold build, wait a beat after camera-ready before
    // mounting the renderer so the user perceives a clean sequence:
    // camera fades in → tiny held breath → orbs unfold from a single
    // bright dot at origin. ~380ms is long enough to register, short
    // enough to feel responsive.
    let scene: SceneRefs | null = null;
    let pendingTimer: number | null = null;
    const doBuild = () => {
      pendingTimer = null;
      if (!graphContainerRef.current) return;
      scene = buildScene(
        graphContainerRef.current,
        layoutNodes,
        layoutEdges,
        positions,
        knownPositionsRef.current,
      );
      sceneRef.current = scene;
      // Flip the seal AFTER a successful mount so a cleanup-during-
      // delay can't strand us in a stale "unsealed but not built" state.
      if (isUnfoldBuild) {
        sceneUnsealedRef.current = true;
        setStatus("tracking — left pinch rotates/zooms, right pinch on a node marks");
      }
    };
    if (isUnfoldBuild) {
      pendingTimer = window.setTimeout(doBuild, 380);
    } else {
      doBuild();
    }

    return () => {
      if (pendingTimer !== null) window.clearTimeout(pendingTimer);
      if (scene) {
        // Snapshot positions BEFORE disposing so the next rebuild
        // (e.g., when a new node arrives) preserves them.
        knownPositionsRef.current = captureCurrentPositions(scene);
        disposeScene(scene);
        sceneRef.current = null;
      }
    };
  }, [nodes, edges, cameraReady]);

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
    // Tracks the orb that was hovered when the right pinch began. When
    // expandOnPinch is on, activation is deferred until the pinch ends
    // — a quick release activates the orb (no card), a sustained pinch
    // (≥ HOLD_PINCH_MS) opens its context card. When the toggle is off,
    // pinch-down activates immediately and this stays null.
    let pendingActivateId: string | null = null;

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

          if (scene) {
            const w = overlay.width;
            const h = overlay.height;
            // Refresh anchors for every visible orb so any open context
            // cards can follow their orb as the constellation rotates.
            // Cheap: one matrix project per orb, run alongside the pick.
            const anchors = cardAnchorsRef.current;
            anchors.clear();
            let bestId: string | null = null;
            let bestD = POINTER_PICK_RADIUS_PX;
            const fx = frame.pointerScreen ? w - frame.pointerScreen.x : NaN;
            const fy = frame.pointerScreen ? frame.pointerScreen.y : NaN;
            scene.nodeMeshes.forEach((mesh, id) => {
              const p = projectNodeToScreen(mesh, scene.camera, w, h);
              anchors.set(id, p);
              if (frame.pointerScreen) {
                const d = Math.hypot(p.x - fx, p.y - fy);
                if (d < bestD) {
                  bestD = d;
                  bestId = id;
                }
              }
            });

            if (frame.pointerScreen && bestId !== highlightedId) {
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

          // Pinch semantics with hold-vs-tap discrimination:
          //   expandOnPinch ON  → quick pinch activates, hold expands
          //   expandOnPinch OFF → pinch-down activates immediately
          if (frame.pointerPinchEdge === "down" && highlightedId) {
            if (expandOnPinchRef.current) {
              // Defer: wait to see if user releases (tap → activate) or
              // holds past HOLD_PINCH_MS (→ expand context card).
              pendingActivateId = highlightedId;
            } else {
              toggleActivatedRef.current(highlightedId);
            }
          }
          if (
            frame.pointerHoldPinch &&
            expandOnPinchRef.current &&
            pendingActivateId
          ) {
            toggleCardRef.current(pendingActivateId);
            pendingActivateId = null; // hold consumed — the up edge won't activate
          }
          if (frame.pointerPinchEdge === "up" && pendingActivateId) {
            // Pinch released before the hold threshold → quick pinch.
            toggleActivatedRef.current(pendingActivateId);
            pendingActivateId = null;
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
        // Distance + tier label fade — must run AFTER the camera has
        // moved this frame so distances reflect what the user actually
        // sees, and AFTER updateAnimations so orb positions are current.
        // Hovered orb + any orb with an open context card override the
        // fade so the user can always read what they're interacting with.
        const openCards = useArContextStore.getState().openCards;
        const pinnedLabelIds =
          openCards.length > 0
            ? new Set(openCards.map((c) => c.nodeId))
            : null;
        updateLabelVisibility(scene, {
          hoveredId: highlightedId,
          pinnedIds: pinnedLabelIds,
        });
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
      <NodeContextCardHost
        anchorsRef={cardAnchorsRef}
        width={stageSize.w}
        height={stageSize.h}
        resolveSpeakerColor={(id) => {
          const node = useGraphStore.getState().nodes[id];
          if (node?.speaker_id && speakerColors[node.speaker_id]) {
            return speakerColors[node.speaker_id]!;
          }
          return "#a0aab5";
        }}
      />
      <div className="ar-controls">
        <button
          type="button"
          role="switch"
          aria-checked={expandOnPinch}
          aria-label="Toggle: expand context card on hold-pinch"
          className={`ar-toggle ar-toggle--${expandOnPinch ? "on" : "off"}`}
          onClick={() => {
            // Closing any open cards when turning off feels like the
            // right model — "off" should mean "no expansions on screen".
            if (expandOnPinch) closeAllCards();
            toggleExpandOnPinch();
          }}
        >
          <span className="ar-toggle__dot" aria-hidden />
          <span className="ar-toggle__label">
            Expand on pinch
            <strong> · {expandOnPinch ? "On" : "Off"}</strong>
          </span>
        </button>
        <button className="ar-exit" onClick={onExit}>
          Exit AR
        </button>
      </div>
    </div>
  );
}
