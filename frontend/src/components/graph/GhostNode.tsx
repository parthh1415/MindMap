import { motion, useReducedMotion } from "framer-motion";
import { Handle, Position, type NodeProps } from "reactflow";

export type GhostNodeData = {
  ghost_id: string;
  label: string;
  speakerColor: string;
};

/**
 * Ghost node: a not-yet-committed concept being heard live.
 *
 * Visual character:
 *   - Lower opacity, dashed border, infinite subtle pulse.
 *   - Wrapped in a Framer `motion` container with `layoutId={ghost_id}`.
 *     When the backend confirms the ghost (node_upsert resolves_ghost_id),
 *     a SolidNode mounts with the SAME layoutId and Framer morphs in place.
 */
export function GhostNode(props: NodeProps<GhostNodeData>) {
  const { ghost_id, label, speakerColor } = props.data;
  const reduceMotion = useReducedMotion();

  return (
    <motion.div
      layoutId={ghost_id}
      initial={reduceMotion ? false : { opacity: 0, scale: 0.85 }}
      animate={
        reduceMotion
          ? { opacity: 0.7 }
          : { opacity: [0.55, 0.85, 0.55], scale: [0.98, 1.02, 0.98] }
      }
      transition={
        reduceMotion
          ? { duration: 0 }
          : { duration: 2.4, repeat: Infinity, ease: "easeInOut" }
      }
      style={{
        boxShadow: `0 0 18px 4px ${speakerColor}55`,
        borderColor: `${speakerColor}aa`,
      }}
      className="ghost-node"
      aria-label={`Possible concept: ${label}`}
      data-ghost-id={ghost_id}
    >
      <span className="ghost-node__dot" style={{ background: speakerColor }} aria-hidden />
      <span className="ghost-node__label">{label}</span>
      <span className="ghost-node__hint">appearing…</span>
      <Handle type="target" position={Position.Top} className="rf-handle-ghost" />
      <Handle type="source" position={Position.Bottom} className="rf-handle-ghost" />

      <style>{`
        .ghost-node {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          padding: var(--space-2) var(--space-3);
          min-width: 120px;
          border-radius: var(--radius-md);
          border: 1.5px dashed;
          background: rgba(15, 23, 42, 0.4);
          backdrop-filter: blur(6px);
          font-family: var(--font-display);
          color: var(--text-secondary);
          will-change: transform, opacity;
        }
        .ghost-node__dot {
          width: 8px;
          height: 8px;
          border-radius: 999px;
          flex-shrink: 0;
        }
        .ghost-node__label {
          font-size: var(--font-size-sm);
          font-weight: 500;
          color: var(--text-primary);
        }
        .ghost-node__hint {
          font-size: var(--font-size-xs);
          color: var(--text-tertiary);
          font-style: italic;
        }
        .rf-handle-ghost {
          width: 4px;
          height: 4px;
          background: var(--border-subtle);
          border: none;
          opacity: 0.3;
        }
      `}</style>
    </motion.div>
  );
}

export default GhostNode;
