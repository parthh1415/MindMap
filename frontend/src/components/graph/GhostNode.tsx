import { motion, useReducedMotion } from "framer-motion";
import { Handle, Position, type NodeProps } from "reactflow";

export type GhostNodeData = {
  ghost_id: string;
  label: string;
  speakerColor: string;
};

/**
 * Ghost: a not-yet-committed concept the system thinks it heard. Wrapped
 * in a Framer Motion shell with `layoutId={ghost_id}` so the eventual
 * SolidNode (mounted with the same layoutId via `isGhostResolution`) can
 * morph in place — the signature transition.
 */
export function GhostNode(props: NodeProps<GhostNodeData>) {
  const { ghost_id, label, speakerColor } = props.data;
  const reduce = useReducedMotion();

  return (
    <motion.div
      layoutId={ghost_id}
      initial={reduce ? false : { opacity: 0, scale: 0.9 }}
      animate={
        reduce
          ? { opacity: 0.7 }
          : { opacity: [0.5, 0.78, 0.5], scale: [0.99, 1.015, 0.99] }
      }
      transition={
        reduce
          ? { duration: 0 }
          : { duration: 1.7, repeat: Infinity, ease: "easeInOut" }
      }
      style={{
        ["--ghost-speaker" as string]: speakerColor,
      }}
      className="gn"
      aria-label={`Possible concept: ${label}`}
      data-ghost-id={ghost_id}
    >
      <span className="gn__dot" aria-hidden />
      <span className="gn__label">{label}</span>
      <span className="gn__hint">appearing…</span>
      <Handle type="target" position={Position.Top} className="rf-handle-ghost" />
      <Handle type="source" position={Position.Bottom} className="rf-handle-ghost" />

      <style>{`
        .gn {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 12px;
          min-width: 132px;
          border-radius: 10px;
          border: 1px dashed color-mix(in srgb, var(--ghost-speaker) 65%, transparent);
          background:
            linear-gradient(180deg,
              color-mix(in srgb, var(--bg-base) 92%, var(--ghost-speaker)),
              var(--bg-base));
          backdrop-filter: blur(4px);
          color: var(--text-secondary);
          will-change: transform, opacity;
          box-shadow:
            0 0 0 1px color-mix(in srgb, var(--ghost-speaker) 25%, transparent),
            0 0 14px 2px color-mix(in srgb, var(--ghost-speaker) 22%, transparent);
        }
        .gn__dot {
          width: 6px; height: 6px;
          border-radius: 999px;
          background: var(--ghost-speaker);
          box-shadow: 0 0 8px var(--ghost-speaker);
          flex-shrink: 0;
        }
        .gn__label {
          font-family: var(--font-display);
          font-size: 12px;
          font-weight: 500;
          font-style: italic;
          color: var(--text-primary);
        }
        .gn__hint {
          font-family: var(--font-mono);
          font-size: 10px;
          color: var(--text-tertiary);
          letter-spacing: 0.04em;
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
