import { motion, useReducedMotion } from "framer-motion";
import { BaseEdge, getBezierPath, type EdgeProps } from "reactflow";
import type { EdgeType } from "@shared/ws_messages";
import { tweenEdgeDraw } from "@/lib/motion";

export type GraphEdgeData = {
  edge_type: EdgeType;
  speakerColor: string;
};

/**
 * Custom edge with animated pathLength on mount + gradient stroke tinted
 * by the source-node speaker color.
 */
export function EdgeRenderer(props: EdgeProps<GraphEdgeData>) {
  const reduceMotion = useReducedMotion();
  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    data,
    markerEnd,
  } = props;

  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const stroke = data?.speakerColor ?? "var(--border-default)";
  const dash =
    data?.edge_type === "dashed"
      ? "8 6"
      : data?.edge_type === "dotted"
        ? "2 6"
        : undefined;

  const gradientId = `edge-grad-${id}`;

  return (
    <>
      <defs>
        <linearGradient id={gradientId} x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity={0.9} />
          <stop offset="100%" stopColor={stroke} stopOpacity={0.35} />
        </linearGradient>
      </defs>
      <motion.path
        id={id}
        d={edgePath}
        stroke={`url(#${gradientId})`}
        strokeWidth={1.6}
        fill="none"
        strokeDasharray={dash}
        markerEnd={markerEnd}
        initial={reduceMotion ? { pathLength: 1, opacity: 1 } : { pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={reduceMotion ? { duration: 0 } : tweenEdgeDraw}
        style={{ filter: `drop-shadow(0 0 4px ${stroke}55)` }}
      />
      {/* invisible base edge keeps reactflow's hit-testing happy */}
      <BaseEdge id={`${id}-hit`} path={edgePath} style={{ stroke: "transparent", strokeWidth: 12 }} />
    </>
  );
}

export default EdgeRenderer;
