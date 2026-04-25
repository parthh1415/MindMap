import { motion, useReducedMotion } from "framer-motion";
import { Handle, Position, type NodeProps } from "reactflow";
import type { Node as ContractNode } from "@shared/ws_messages";
import { springEntrance, springTap } from "@/lib/motion";
import { useGraphStore } from "@/state/graphStore";

export type SolidNodeData = {
  contractNode: ContractNode;
  speakerColor: string; // CSS var or hex
  isActiveSpeaker: boolean;
  isGhostResolution: boolean; // true when this node was just upserted with resolves_ghost_id
};

/**
 * A "solid" (committed) graph node.
 *
 * Visual character:
 *   - Rounded 8px body with subtle inner gradient.
 *   - Outer ring glow tinted by speaker color (NOT a flat border).
 *   - Importance reflected in size via spring (stiffness 260, damping 22).
 *   - Hover lifts and scales.
 *   - Click → opens edit modal (handled by canvas via onSelect).
 *   - When `isGhostResolution` is true the node ships with a `layoutId`
 *     equal to the resolving ghost id so Framer Motion morphs the ghost
 *     into this node — the signature transition.
 */
export function SolidNode(props: NodeProps<SolidNodeData>) {
  const { contractNode: node, speakerColor, isActiveSpeaker, isGhostResolution } = props.data;
  const reduceMotion = useReducedMotion();

  // importance_score 0..1 → size 140px..220px
  const baseSize = 140 + Math.max(0, Math.min(1, node.importance_score)) * 80;
  const layoutId = isGhostResolution ? `ghost-${node._id}-resolves` : undefined;

  const selectNode = useGraphStore((s) => s.selectNode);

  return (
    <motion.button
      layoutId={layoutId}
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        selectNode(node._id);
      }}
      initial={reduceMotion ? false : { opacity: 0, scale: 0, filter: "blur(4px)" }}
      animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
      whileHover={reduceMotion ? undefined : { y: -2, scale: 1.02 }}
      whileTap={reduceMotion ? undefined : { scale: 0.98 }}
      transition={reduceMotion ? { duration: 0 } : springEntrance}
      style={{
        width: baseSize,
        minHeight: 56,
        // outer glow ring (NOT a flat border)
        boxShadow: isActiveSpeaker
          ? `0 0 0 1px ${speakerColor}, 0 0 28px 6px ${speakerColor}, var(--elev-2)`
          : `0 0 0 1px ${speakerColor}66, 0 0 18px 2px ${speakerColor}33, var(--elev-1)`,
      }}
      className="solid-node"
      aria-label={`Node: ${node.label}`}
    >
      <motion.div
        className="solid-node__body"
        whileHover={reduceMotion ? undefined : { scale: 1.0 }}
        transition={springTap}
      >
        {node.image_url ? (
          <motion.img
            src={node.image_url}
            alt=""
            className="solid-node__image"
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={springEntrance}
          />
        ) : null}
        <span className="solid-node__label" title={node.label}>
          {node.label}
        </span>
        {node.info.length > 0 ? (
          <span className="solid-node__meta">
            {node.info.length} note{node.info.length === 1 ? "" : "s"}
          </span>
        ) : null}
      </motion.div>
      <Handle type="target" position={Position.Top} className="rf-handle" />
      <Handle type="source" position={Position.Bottom} className="rf-handle" />

      <style>{`
        .solid-node {
          position: relative;
          padding: 0;
          border-radius: var(--radius-md);
          background: linear-gradient(180deg, var(--bg-raised) 0%, var(--bg-surface) 100%);
          color: var(--text-primary);
          font-family: var(--font-display);
          text-align: left;
          will-change: transform, box-shadow;
        }
        .solid-node__body {
          display: flex;
          flex-direction: column;
          gap: var(--space-1);
          padding: var(--space-3) var(--space-4);
        }
        .solid-node__image {
          width: 100%;
          height: 80px;
          object-fit: cover;
          border-radius: var(--radius-sm);
          margin-bottom: var(--space-2);
        }
        .solid-node__label {
          font-size: var(--font-size-md);
          font-weight: 600;
          line-height: var(--line-height-tight);
          color: var(--text-primary);
          word-break: break-word;
        }
        .solid-node__meta {
          font-size: var(--font-size-xs);
          color: var(--text-tertiary);
          font-feature-settings: "tnum" 1;
        }
        .rf-handle {
          width: 6px;
          height: 6px;
          background: var(--border-default);
          border: none;
          opacity: 0.4;
        }
      `}</style>
    </motion.button>
  );
}

export default SolidNode;
