import { useEffect, useRef, useState } from "react";
import { useGraphStore, selectNodeList, selectEdgeList } from "@/state/graphStore";
import { useShallow } from "zustand/react/shallow";
import { startWebcam, stopWebcam } from "./cameraLifecycle";
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

export default function ARStage({ onExit }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const graphContainerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("starting…");
  const { fps, tick, latency } = useFps();

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

    (async () => {
      try {
        if (nodes.length === 0) {
          setStatus("no nodes — run a session first");
          return;
        }
        const v = videoRef.current!;
        const overlay = overlayRef.current!;
        const gc = graphContainerRef.current!;

        stream = await startWebcam(v);
        // Match overlay/canvas size to video element
        overlay.width = v.videoWidth || 1280;
        overlay.height = v.videoHeight || 720;

        // Defensive filter: drop edges whose endpoints aren't in the
        // current node set. Otherwise d3-force-3d's forceLink throws
        // "node not found: <id>" and the whole AR view dies. This can
        // happen with orphan edges (source/target node was deleted)
        // or when the topology agent emitted a label that never got
        // resolved to a real node id on the backend.
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

        const detector = await initDetector();
        setStatus("tracking");

        const ctx = overlay.getContext("2d")!;

        const loop = async () => {
          if (cancelled) return;
          const t0 = performance.now();
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

          // Pose smoothing
          current.yaw += (target.yaw - current.yaw) * ROTATION_DAMPING;
          current.pitch += (target.pitch - current.pitch) * ROTATION_DAMPING;
          current.camZ += (target.camZ - current.camZ) * ZOOM_CAMERA_DAMPING;

          if (scene) {
            const e = new THREE.Euler(current.pitch, current.yaw, 0, "YXZ");
            scene.graphRoot.quaternion.setFromEuler(e);
            scene.camera.position.z = current.camZ;
            scene.camera.lookAt(0, 0, 0);
            scene.renderer.render(scene.scene, scene.camera);

            // Pointer picking
            let newHover: string | null = null;
            if (frame.pointerScreen) {
              const w = overlay.width, h = overlay.height;
              // Mirror correction (overlay flipped via CSS scaleX(-1), but
              // canvas pixels are not flipped — so we mirror the fingertip.)
              const fx = w - frame.pointerScreen.x;
              const fy = frame.pointerScreen.y;
              let bestId: string | null = null, bestD = POINTER_PICK_RADIUS_PX;
              scene.nodeMeshes.forEach((mesh, id) => {
                const p = projectNodeToScreen(mesh, scene!.camera, w, h);
                const d = Math.hypot(p.x - fx, p.y - fy);
                if (d < bestD) { bestD = d; bestId = id; }
              });
              newHover = bestId;
            }

            // Apply hover/active visual state on TRANSITION only
            if (newHover !== highlightedId) {
              if (highlightedId) {
                const prev = scene.nodeMeshes.get(highlightedId);
                if (prev) setNodeColor(
                  prev,
                  activatedRef.current.has(highlightedId) ? "active" : "base",
                );
              }
              if (newHover) {
                const m = scene.nodeMeshes.get(newHover);
                if (m) setNodeColor(m, "hover");
              }
              highlightedId = newHover;
            }

            // Pinch-edge → toggle activation (uses ref for latest action)
            if (frame.pointerPinchEdge === "down" && highlightedId) {
              toggleActivatedRef.current(highlightedId);
            }
            // (No more bulk forEach repaint — Effect 2 handles activatedNodeIds changes.)
          }

          drawHands(ctx, tracks, overlay.width, overlay.height);
          tickRef.current(performance.now() - t0);
          raf = requestAnimationFrame(loop);
        };
        loop();
      } catch (err) {
        console.error("[AR] startup failed", err);
        setStatus(`error: ${(err as Error).message}`);
      }
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

  // Effect 2: Repaint node colors when activatedNodeIds changes — no scene rebuild.
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
      </div>
      <button className="ar-exit" onClick={onExit}>Exit AR</button>
    </div>
  );
}
