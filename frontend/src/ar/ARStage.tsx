import { useEffect, useRef, useState } from "react";
import { useGraphStore } from "@/state/graphStore";
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

  const nodes = useGraphStore((s) => Object.values(s.nodes));
  const edges = useGraphStore((s) => Object.values(s.edges));
  const activatedNodeIds = useGraphStore((s) => s.activatedNodeIds);
  const toggleActivated = useGraphStore((s) => s.toggleActivated);

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

        const positions = computeLayout(
          nodes.map((n) => ({ _id: n._id, label: n.label })),
          edges.map((e) => ({ source_id: e.source_id, target_id: e.target_id })),
        );
        scene = buildScene(
          gc,
          nodes.map((n) => ({ _id: n._id, label: n.label })),
          edges.map((e) => ({ source_id: e.source_id, target_id: e.target_id })),
          positions,
        );

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

            // Apply hover/active visual state
            if (newHover !== highlightedId) {
              if (highlightedId) {
                const prev = scene.nodeMeshes.get(highlightedId);
                if (prev) setNodeColor(
                  prev,
                  activatedNodeIds.has(highlightedId) ? "active" : "base",
                );
              }
              if (newHover) {
                const m = scene.nodeMeshes.get(newHover);
                if (m) setNodeColor(m, "hover");
              }
              highlightedId = newHover;
            }

            // Pinch-edge → toggle activation
            if (frame.pointerPinchEdge === "down" && highlightedId) {
              toggleActivated(highlightedId);
            }

            // Re-color all activated nodes that aren't currently hovered
            scene.nodeMeshes.forEach((mesh, id) => {
              if (id === highlightedId) return;
              setNodeColor(mesh, activatedNodeIds.has(id) ? "active" : "base");
            });
          }

          drawHands(ctx, tracks, overlay.width, overlay.height);
          tick(performance.now() - t0);
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
      if (videoRef.current) stopWebcam(stream, videoRef.current);
      void disposeDetector();
      if (scene) disposeScene(scene);
      clearTrackingState();
    };
  }, [nodes, edges, activatedNodeIds, toggleActivated, tick]);

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
