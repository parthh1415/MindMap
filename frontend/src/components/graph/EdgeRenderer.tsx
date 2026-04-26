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
 * White connecting line — visually paired with the 3D AR view's white
 * edges so the two modes feel like the same product. On the dark
 * canvas a 0.1-opacity gray edge was effectively invisible; the new
 * default reads at a glance without overpowering the orbs.
 *
 *   default opacity   ≈ 0.55  (was 0.10)
 *   emphasized        ≈ 0.85  (was 0.55)
 *   dimmed            ≈ 0.10  (was 0.04)
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

  const targetOpacity = data?.dimmed ? 0.10 : data?.emphasized ? 0.85 : 0.55;

  return (
    <>
      <motion.path
        id={id}
        d={edgePath}
        stroke="#ffffff"
        strokeWidth={1.4}
        fill="none"
        strokeDasharray={dash}
        strokeLinecap="round"
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
