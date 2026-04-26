import { motion, useReducedMotion } from "framer-motion";
import { BaseEdge, getBezierPath, type EdgeProps } from "reactflow";
import type { EdgeType } from "@shared/ws_messages";
import { tweenEdgeDraw } from "@/lib/motion";

export type GraphEdgeData = {
  edge_type: EdgeType;
  speakerColor: string;
  /** Hover-state from GraphCanvas — true when neither endpoint is in
   *  the currently-hovered node's neighborhood (Obsidian dim). */
  dimmed?: boolean;
  /** True when both endpoints are connected to the hovered node — the
   *  edge stays bright. */
  emphasized?: boolean;
};

/**
 * Obsidian-style edge: a single thin uniform-gray line. No gradient,
 * no drop-shadow, no per-edge color.
 *
 *   default opacity   ≈ 0.10
 *   emphasized        ≈ 0.55
 *   dimmed            ≈ 0.04
 *
 * pathLength still animates 0→1 on mount so new edges feel drawn rather
 * than popped.
 */
export function EdgeRenderer(props: EdgeProps<GraphEdgeData>) {
  const reduce = useReducedMotion();
  const {
    id, sourceX, sourceY, targetX, targetY,
    sourcePosition, targetPosition, data, markerEnd,
  } = props;

  const [edgePath] = getBezierPath({
    sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition,
  });

  const dash =
    data?.edge_type === "dashed"
      ? "6 4"
      : data?.edge_type === "dotted"
        ? "1.5 4"
        : undefined;

  const targetOpacity = data?.dimmed ? 0.04 : data?.emphasized ? 0.55 : 0.1;

  return (
    <>
      <motion.path
        id={id}
        d={edgePath}
        stroke="rgba(232, 237, 242, 1)"
        strokeWidth={1}
        fill="none"
        strokeDasharray={dash}
        markerEnd={markerEnd}
        initial={reduce ? { pathLength: 1, opacity: targetOpacity } : { pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, opacity: targetOpacity }}
        transition={reduce ? { duration: 0 } : tweenEdgeDraw}
      />
      {/* Wider invisible hit-area so users can hover/click thin edges. */}
      <BaseEdge id={`${id}-hit`} path={edgePath} style={{ stroke: "transparent", strokeWidth: 12 }} />
    </>
  );
}

export default EdgeRenderer;
