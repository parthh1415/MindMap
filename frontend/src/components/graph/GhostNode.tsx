import { motion, useReducedMotion } from "framer-motion";
import { Handle, Position, type NodeProps } from "reactflow";

export type GhostNodeData = {
  ghost_id: string;
  label: string;
  speakerColor: string;
};

/**
 * Obsidian-style ghost orb — small dashed-outline circle with a muted
 * italic label below. Shares `layoutId={ghost_id}` with the eventual
 * SolidNode so Framer Motion morphs it into the solid in place.
 */
export function GhostNode(props: NodeProps<GhostNodeData>) {
  const { ghost_id, label, speakerColor } = props.data;
  const reduce = useReducedMotion();

  return (
    <div className="orb-wrap orb-wrap--ghost">
      <motion.div
        layoutId={ghost_id}
        initial={reduce ? false : { opacity: 0, scale: 0 }}
        animate={
          reduce
            ? { opacity: 0.7, scale: 1 }
            : { opacity: [0.45, 0.85, 0.45], scale: [0.95, 1.04, 0.95] }
        }
        transition={
          reduce
            ? { duration: 0 }
            : { duration: 1.6, repeat: Infinity, ease: "easeInOut" }
        }
        className="ghost-orb"
        style={{
          borderColor: `color-mix(in srgb, ${speakerColor} 75%, transparent)`,
        }}
        aria-label={`Possible concept: ${label}`}
        data-ghost-id={ghost_id}
      />
      <span className="ghost-orb-label" aria-hidden>
        {label}
      </span>

      <Handle type="target" position={Position.Top} className="rf-handle-ghost" />
      <Handle type="source" position={Position.Bottom} className="rf-handle-ghost" />

      <style>{`
        .orb-wrap--ghost {
          position: relative;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 6px;
          transform: translate(-50%, -50%);
          padding-bottom: 18px;
        }
        .ghost-orb {
          width: 14px;
          height: 14px;
          border-radius: 999px;
          border: 1.4px dashed;
          background: transparent;
          flex-shrink: 0;
        }
        .ghost-orb-label {
          font-family: var(--font-body);
          font-size: 10.5px;
          font-style: italic;
          color: var(--text-tertiary);
          letter-spacing: -0.005em;
          line-height: 1.15;
          text-align: center;
          max-width: 140px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          pointer-events: none;
          user-select: none;
          text-shadow: 0 1px 4px rgba(0,0,0,0.85);
        }
        .rf-handle-ghost {
          width: 1px;
          height: 1px;
          background: transparent;
          border: none;
          opacity: 0;
        }
      `}</style>
    </div>
  );
}

export default GhostNode;
