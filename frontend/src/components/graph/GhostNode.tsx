import { memo } from "react";
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
function GhostNodeImpl(props: NodeProps<GhostNodeData>) {
  const { ghost_id, label, speakerColor } = props.data;
  const reduce = useReducedMotion();

  return (
    <div className="orb-wrap orb-wrap--ghost" style={{ ["--gs" as string]: speakerColor }}>
      <motion.div
        layoutId={ghost_id}
        initial={reduce ? false : { opacity: 0, scale: 0 }}
        animate={
          reduce
            ? { opacity: 0.85, scale: 1 }
            // Mount: pop to 1.25x with full opacity (so user notices appearance),
            // then settle to a slow breath between 0.7-1.0 opacity.
            : { opacity: [0, 1, 0.78, 0.95, 0.78], scale: [0, 1.25, 1, 1, 1] }
        }
        transition={
          reduce
            ? { duration: 0 }
            : { duration: 2.2, ease: "easeOut", times: [0, 0.18, 0.36, 0.7, 1] }
        }
        className="ghost-orb"
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
          gap: 7px;
          transform: translate(-50%, -50%);
          padding-bottom: 22px;
        }
        .ghost-orb {
          /* Visually paired with SolidNode: same lit-sphere gradient
             but kept translucent + dashed-rimmed so it still reads as
             "tentative". The halo box-shadow is softer than a solid
             so a ghost never out-shines a real node. */
          width: 24px;
          height: 24px;
          border-radius: 999px;
          border: 1.5px dashed var(--gs);
          background:
            radial-gradient(
              circle at 32% 30%,
              color-mix(in srgb, var(--gs) 18%, #ffffff 5%) 0%,
              color-mix(in srgb, var(--gs) 35%, transparent) 45%,
              color-mix(in srgb, var(--gs) 14%, transparent) 80%,
              transparent 100%
            );
          box-shadow:
            0 0 10px color-mix(in srgb, var(--gs) 30%, transparent),
            0 0 22px color-mix(in srgb, var(--gs) 18%, transparent),
            inset 0 0 4px color-mix(in srgb, #ffffff 25%, transparent);
          flex-shrink: 0;
        }
        .ghost-orb-label {
          font-family: var(--font-body);
          font-size: 11.5px;
          font-weight: 500;
          font-style: italic;
          color: color-mix(in srgb, var(--gs) 65%, var(--text-secondary));
          letter-spacing: -0.005em;
          line-height: 1.15;
          text-align: center;
          max-width: 140px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          pointer-events: none;
          user-select: none;
          text-shadow: 0 1px 4px rgba(0,0,0,0.92);
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

/** Skip body re-render unless visual fields change — same reasoning
 *  as SolidNode: reactflow passes fresh data literals every tick. */
export const GhostNode = memo(GhostNodeImpl, (prev, next) => {
  if (prev.id !== next.id) return false;
  const a = prev.data;
  const b = next.data;
  return (
    a.ghost_id === b.ghost_id &&
    a.label === b.label &&
    a.speakerColor === b.speakerColor
  );
});

export default GhostNode;
