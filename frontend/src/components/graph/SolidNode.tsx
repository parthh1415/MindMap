import { motion, useReducedMotion } from "framer-motion";
import { Handle, Position, type NodeProps } from "reactflow";
import type { Node as ContractNode } from "@shared/ws_messages";
import { springTap } from "@/lib/motion";
import { useGraphStore } from "@/state/graphStore";

export type SolidNodeData = {
  contractNode: ContractNode;
  speakerColor: string;
  isActiveSpeaker: boolean;
  isGhostResolution: boolean;
  /** Set true when another node is hovered and this one is NOT in the
   *  hovered node's 1-hop neighborhood — Obsidian's signature dim. */
  dimmed: boolean;
};

/**
 * Obsidian-style orb. Small flat-filled circle (12-30px) with a label
 * rendered BELOW it in muted text. No gradient, no inner glow, no
 * border decoration — just a solid disc that scales with importance.
 *
 * Hover: orb pops to 1.25x and the label sharpens. The dimming of
 * unconnected orbs happens via the `dimmed` data flag passed in from
 * GraphCanvas (it tracks which node is hovered and computes neighbors).
 *
 * Ghost-resolution morph still uses a shared layoutId.
 */
export function SolidNode(props: NodeProps<SolidNodeData>) {
  const { contractNode: node, speakerColor, isActiveSpeaker, isGhostResolution, dimmed } = props.data;
  const reduce = useReducedMotion();

  const importance = Math.max(0, Math.min(1, node.importance_score));
  const diameter = Math.round(12 + importance * 18); // 12 → 30px
  const layoutId = isGhostResolution ? `ghost-${node._id}-resolves` : undefined;

  const selectNode = useGraphStore((s) => s.selectNode);

  return (
    <motion.div
      className="orb-wrap"
      animate={{ opacity: dimmed ? 0.22 : 1 }}
      transition={reduce ? { duration: 0 } : { duration: 0.18, ease: "easeOut" }}
    >
      <motion.button
        layoutId={layoutId}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          selectNode(node._id);
        }}
        initial={reduce ? false : { opacity: 0, scale: 0 }}
        animate={{ opacity: 1, scale: isActiveSpeaker ? 1.18 : 1 }}
        whileHover={reduce ? undefined : { scale: 1.25 }}
        whileTap={reduce ? undefined : { scale: 0.92 }}
        transition={reduce ? { duration: 0 } : springTap}
        style={{
          width: diameter,
          height: diameter,
          background: speakerColor,
          // Active speaker gets a subtle ring; otherwise NOTHING — pure flat disc.
          boxShadow: isActiveSpeaker
            ? `0 0 0 2px color-mix(in srgb, ${speakerColor} 35%, transparent)`
            : "none",
        }}
        className="orb"
        aria-label={`Node: ${node.label}`}
      />

      <span className="orb-label" title={node.label} aria-hidden>
        {node.label}
      </span>

      <Handle type="target" position={Position.Top} className="rf-handle" />
      <Handle type="source" position={Position.Bottom} className="rf-handle" />

      <style>{`
        .orb-wrap {
          position: relative;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 6px;
          /* Re-anchor so reactflow's top-left coordinate places the orb's
             centre, not the wrap's top edge. The wrap is taller than the
             orb because of the label. */
          transform: translate(-50%, -50%);
          padding-top: 0;
          padding-bottom: 18px;
          will-change: transform, opacity;
        }
        .orb {
          padding: 0;
          border: none;
          border-radius: 999px;
          flex-shrink: 0;
          cursor: pointer;
          will-change: transform, box-shadow;
        }
        .orb-label {
          font-family: var(--font-body);
          font-size: 10.5px;
          font-weight: 500;
          color: var(--text-secondary);
          letter-spacing: -0.005em;
          line-height: 1.15;
          text-align: center;
          max-width: 140px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          pointer-events: none;
          user-select: none;
          /* readability over the dark canvas without a hard pill bg */
          text-shadow: 0 1px 4px rgba(0,0,0,0.85);
        }
        .rf-handle {
          width: 1px;
          height: 1px;
          background: transparent;
          border: none;
          opacity: 0;
        }
      `}</style>
    </motion.div>
  );
}

export default SolidNode;
