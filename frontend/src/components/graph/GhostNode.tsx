import { motion, useReducedMotion } from "framer-motion";
import { Handle, Position, type NodeProps } from "reactflow";

export type GhostNodeData = {
  ghost_id: string;
  label: string;
  speakerColor: string;
};

/**
 * Ghost node — circular, half-rendered concept the system thinks it
 * heard but the topology agent hasn't committed yet. Smaller than a
 * solid node, dashed speaker-tinted ring, label centered, infinite
 * gentle pulse. Shares a `layoutId={ghost_id}` with the eventual
 * SolidNode so Framer Motion morphs the ghost into the solid in place.
 */
export function GhostNode(props: NodeProps<GhostNodeData>) {
  const { ghost_id, label, speakerColor } = props.data;
  const reduce = useReducedMotion();

  const long = label.length > 14;

  return (
    <motion.div
      layoutId={ghost_id}
      initial={reduce ? false : { opacity: 0, scale: 0.6 }}
      animate={
        reduce
          ? { opacity: 0.7 }
          : { opacity: [0.55, 0.85, 0.55], scale: [0.98, 1.02, 0.98] }
      }
      transition={
        reduce
          ? { duration: 0 }
          : { duration: 1.8, repeat: Infinity, ease: "easeInOut" }
      }
      style={{ ["--ghost-speaker" as string]: speakerColor }}
      className="gn"
      aria-label={`Possible concept: ${label}`}
      data-ghost-id={ghost_id}
    >
      <span
        className="gn__label"
        style={{ fontSize: long ? 11 : 12 }}
      >
        {label}
      </span>
      <span className="gn__hint" aria-hidden>
        appearing
      </span>
      <Handle type="target" position={Position.Top} className="rf-handle-ghost" />
      <Handle type="source" position={Position.Bottom} className="rf-handle-ghost" />

      <style>{`
        .gn {
          position: relative;
          width: 88px;
          height: 88px;
          border-radius: 999px;
          border: 1.5px dashed color-mix(in srgb, var(--ghost-speaker) 75%, transparent);
          background:
            radial-gradient(circle at 30% 30%,
              color-mix(in srgb, var(--bg-base) 80%, var(--ghost-speaker)) 0%,
              var(--bg-base) 70%);
          color: var(--text-secondary);
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 4px;
          padding: 8px 10px;
          will-change: transform, opacity;
          box-shadow:
            0 0 0 1px color-mix(in srgb, var(--ghost-speaker) 22%, transparent),
            0 0 18px 3px color-mix(in srgb, var(--ghost-speaker) 24%, transparent);
        }
        .gn__label {
          font-family: var(--font-display);
          font-weight: 500;
          font-style: italic;
          color: var(--text-primary);
          text-align: center;
          line-height: 1.15;
          letter-spacing: -0.005em;
          padding: 0 2px;
          overflow: hidden;
          text-overflow: ellipsis;
          display: -webkit-box;
          -webkit-line-clamp: 3;
          -webkit-box-orient: vertical;
          word-break: break-word;
        }
        .gn__hint {
          font-family: var(--font-mono);
          font-size: 8px;
          color: var(--text-tertiary);
          letter-spacing: 0.18em;
          text-transform: uppercase;
        }
        .rf-handle-ghost {
          width: 3px;
          height: 3px;
          background: transparent;
          border: none;
          opacity: 0;
        }
      `}</style>
    </motion.div>
  );
}

export default GhostNode;
