import { useEffect, useRef, useState } from "react";
import { useArtifactStore } from "@/state/artifactStore";
import { useGraphStore } from "@/state/graphStore";

/**
 * Cinematic transition between artifact generation and document preview.
 *
 * When the artifact phase flips to "swirl", we:
 *   1. Read the artifact's evidence array to find which node ids the
 *      doc actually cites.
 *   2. Snapshot the cited nodes' on-screen positions by querying their
 *      DOM elements (reactflow assigns data-id attrs to the wrapper).
 *   3. Render volt-yellow ghost orbs at those positions and animate
 *      them via spring physics toward screen center, with bright lines
 *      connecting them. The original 2D graph dims to ~25% during the
 *      swirl so the cinematic moment owns the viewport.
 *   4. After ~1.4s the orbs have converged at center and we call
 *      advanceFromSwirl() — phase flips to "ready" and the
 *      ArtifactPreview modal opens with a scale-up entrance from
 *      the same point.
 *
 * If we can't find DOM elements for the cited nodes (graph not
 * mounted, or evidence has no node_ids), we skip the visuals and
 * advance immediately. The artifactStore also has a 3s safety timer
 * so the user is never stuck on a broken swirl.
 */

interface OrbState {
  id: string;
  startX: number;
  startY: number;
  hue: string;
}

const SWIRL_DURATION_MS = 1400;

// Cubic ease-in-out — slow start, fast middle, soft landing at center.
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export default function GenerateSwirlOverlay() {
  const phase = useArtifactStore((s) => s.phase);
  const artifact = useArtifactStore((s) => s.activeArtifact);
  const advanceFromSwirl = useArtifactStore((s) => s.advanceFromSwirl);

  const [progress, setProgress] = useState(0);
  const [orbs, setOrbs] = useState<OrbState[]>([]);
  const [center, setCenter] = useState({ x: 0, y: 0 });
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (phase !== "swirl") {
      setProgress(0);
      setOrbs([]);
      return;
    }
    if (!artifact) {
      advanceFromSwirl();
      return;
    }

    // Collect unique cited node ids from the evidence array.
    const citedIds = new Set<string>();
    for (const ev of artifact.evidence ?? []) {
      for (const id of ev.node_ids ?? []) {
        if (typeof id === "string" && id) citedIds.add(id);
      }
    }
    if (citedIds.size === 0) {
      advanceFromSwirl();
      return;
    }

    // Capture each cited orb's CURRENT screen position. Reactflow puts
    // its node id on the wrapper as data-id (we also fall back to
    // generic .react-flow__node selectors that happen to contain the
    // id). If a cited node isn't currently mounted (it might have
    // been deleted, or the user collapsed a parent), skip it.
    const captured: OrbState[] = [];
    const speakerColors = useGraphStore.getState().speakerColors;
    const nodeMap = useGraphStore.getState().nodes;
    for (const id of citedIds) {
      const node = nodeMap[id];
      if (!node) continue;
      const el =
        document.querySelector(`[data-id="${id}"]`) ??
        document.querySelector(`.react-flow__node[data-id="${id}"]`);
      if (!(el instanceof HTMLElement)) continue;
      const r = el.getBoundingClientRect();
      const hue =
        (node.speaker_id && speakerColors[node.speaker_id]) ||
        "var(--signature-accent)";
      captured.push({
        id,
        startX: r.left + r.width / 2,
        startY: r.top + r.height / 2,
        hue,
      });
    }

    if (captured.length === 0) {
      advanceFromSwirl();
      return;
    }

    setOrbs(captured);
    setCenter({ x: window.innerWidth / 2, y: window.innerHeight / 2 });

    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / SWIRL_DURATION_MS);
      setProgress(easeInOutCubic(t));
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        advanceFromSwirl();
      }
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [phase, artifact, advanceFromSwirl]);

  if (phase !== "swirl" || orbs.length === 0) return null;

  // Spiral path: orbs arc into the center along a slight curve so the
  // motion reads as "swirl" not just "linear pull". Each orb gets its
  // own tangential offset based on its index.
  const computePos = (orb: OrbState, idx: number) => {
    const dx = center.x - orb.startX;
    const dy = center.y - orb.startY;
    const dist = Math.hypot(dx, dy);
    // Perpendicular unit vector for the spiral curve
    const perpX = dist > 0 ? -dy / dist : 0;
    const perpY = dist > 0 ? dx / dist : 0;
    // Curve magnitude — peaks at progress=0.5, fades at 0 and 1.
    // Sign alternates per orb so they swirl from BOTH sides.
    const curveMag = Math.sin(progress * Math.PI) * 60 * (idx % 2 === 0 ? 1 : -1);
    const x = orb.startX + dx * progress + perpX * curveMag;
    const y = orb.startY + dy * progress + perpY * curveMag;
    return { x, y };
  };

  const positions = orbs.map(computePos);

  return (
    <div className="swirl-overlay" aria-hidden>
      {/* Bright connecting lines between converging orbs */}
      <svg className="swirl-svg">
        {positions.map((a, i) =>
          positions.slice(i + 1).map((b, j) => (
            <line
              key={`${i}-${j + i + 1}`}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
            />
          )),
        )}
      </svg>

      {/* Ghost orbs — pulse brighter as they near center */}
      {positions.map((p, i) => {
        const orb = orbs[i]!;
        const scale = 0.85 + progress * 0.5;
        return (
          <div
            key={orb.id}
            className="swirl-orb"
            style={{
              left: p.x,
              top: p.y,
              transform: `translate(-50%, -50%) scale(${scale})`,
              background: orb.hue,
              boxShadow: `0 0 ${20 + progress * 40}px ${orb.hue}, 0 0 ${
                40 + progress * 80
              }px ${orb.hue}`,
              opacity: 0.85,
            }}
          />
        );
      })}

      {/* Document silhouette emerging at center as orbs coalesce.
          Fades in over the last 30% of the swirl so it feels like the
          orbs are MAKING the document. */}
      <div
        className="swirl-doc"
        style={{
          left: center.x,
          top: center.y,
          opacity: progress > 0.6 ? (progress - 0.6) / 0.4 : 0,
          transform: `translate(-50%, -50%) scale(${0.7 + progress * 0.4})`,
        }}
      />

      <style>{`
        .swirl-overlay {
          position: fixed;
          inset: 0;
          z-index: 80; /* above graph, below modal (var(--z-modal) = 90) */
          pointer-events: none;
          overflow: hidden;
        }
        .swirl-svg {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          pointer-events: none;
        }
        .swirl-svg line {
          stroke: var(--signature-accent);
          stroke-width: 1.5;
          stroke-linecap: round;
          opacity: 0.55;
          filter: drop-shadow(0 0 4px var(--signature-accent-glow));
        }
        .swirl-orb {
          position: fixed;
          width: 18px;
          height: 18px;
          border-radius: 999px;
          pointer-events: none;
          will-change: transform, left, top;
        }
        .swirl-doc {
          position: fixed;
          width: 220px;
          height: 280px;
          border-radius: 14px;
          background: linear-gradient(
            180deg,
            rgba(214, 255, 58, 0.18),
            rgba(214, 255, 58, 0.04)
          );
          border: 1px solid rgba(214, 255, 58, 0.6);
          box-shadow:
            0 0 60px rgba(214, 255, 58, 0.45),
            0 0 120px rgba(214, 255, 58, 0.25);
          pointer-events: none;
          will-change: transform, opacity;
        }
      `}</style>
    </div>
  );
}
