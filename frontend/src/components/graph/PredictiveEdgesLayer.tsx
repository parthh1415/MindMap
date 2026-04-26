import { useMemo } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { useViewport } from "reactflow";
import { useShallow } from "zustand/react/shallow";
import { useGraphStore, type PredictiveEdge } from "@/state/graphStore";
import { getActivePredictive } from "@/lib/predictiveEdges";

type Props = {
  positions: Map<string, { x: number; y: number }>;
};

/**
 * Build a smooth bezier path between two points. Control point is offset
 * perpendicular to the source→target vector by ~25% of edge length so
 * predictive edges curve gently and don't stack on top of real edges.
 */
function bezierPath(
  src: { x: number; y: number },
  tgt: { x: number; y: number },
): string {
  const dx = tgt.x - src.x;
  const dy = tgt.y - src.y;
  const len = Math.hypot(dx, dy) || 1;
  // Perpendicular unit vector
  const px = -dy / len;
  const py = dx / len;
  const offset = Math.min(60, len * 0.25);
  const cx = (src.x + tgt.x) / 2 + px * offset;
  const cy = (src.y + tgt.y) / 2 + py * offset;
  return `M ${src.x} ${src.y} Q ${cx} ${cy} ${tgt.x} ${tgt.y}`;
}

/**
 * SVG overlay that renders one faint, dashed bezier per active predictive
 * edge. Reads positions from the live force simulation (passed in by
 * GraphCanvasInner — DO NOT call useForceLayout here, that would spawn
 * a second simulation). Coords align with reactflow's viewport via
 * `useViewport()` transform.
 *
 * Visual design:
 *   stroke = speaker color, width 0.8, dasharray "3 5"
 *   opacity gently breathes 0 → 0.55 → 0.55 → 0 across TTL window
 *   reducedMotion → static 0.4 opacity, no breathe
 */
export function PredictiveEdgesLayer({ positions }: Props) {
  const reduce = useReducedMotion();
  const { x, y, zoom } = useViewport();

  const predictive = useGraphStore(
    useShallow((s) => getActivePredictive(s)),
  );
  const speakerColors = useGraphStore((s) => s.speakerColors);

  // Filter to those with both endpoints positioned. Memoize so the
  // mapped array reference is stable when positions are unchanged.
  const drawable = useMemo(() => {
    const out: Array<{
      edge: PredictiveEdge;
      d: string;
      color: string;
    }> = [];
    for (const e of predictive) {
      const s = positions.get(e.source_id);
      const t = positions.get(e.target_id);
      if (!s || !t) continue;
      const color = speakerColors[e.speaker_id] || "var(--text-tertiary)";
      out.push({ edge: e, d: bezierPath(s, t), color });
    }
    return out;
  }, [predictive, positions, speakerColors]);

  return (
    <svg
      className="predictive-edges-layer"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        overflow: "visible",
        zIndex: 4,
      }}
    >
      <g transform={`translate(${x} ${y}) scale(${zoom})`}>
        {drawable.map(({ edge, d, color }) => (
          <motion.path
            key={edge.id}
            d={d}
            stroke={color}
            strokeWidth={1.4}
            strokeDasharray="5 4"
            fill="none"
            strokeLinecap="round"
            // brighter + thicker than the original 0.8/0.55 — these are
            // the "the system thinks these are connected" hints the user
            // needs to actually see during real-time speech.
            initial={{ opacity: 0 }}
            animate={
              reduce
                ? { opacity: 0.6 }
                : { opacity: [0, 0.78, 0.78, 0] }
            }
            transition={
              reduce
                ? { duration: 0 }
                : {
                    duration: 12,
                    times: [0, 0.08, 0.85, 1],
                    ease: "easeInOut",
                  }
            }
            style={{ filter: `drop-shadow(0 0 3px ${color})` }}
          />
        ))}
      </g>
    </svg>
  );
}

export default PredictiveEdgesLayer;
