import { motion, useReducedMotion } from "framer-motion";
import { Handle, Position, type NodeProps } from "reactflow";
import type { Node as ContractNode } from "@shared/ws_messages";
import { springEntrance, springTap } from "@/lib/motion";
import { useGraphStore } from "@/state/graphStore";

export type SolidNodeData = {
  contractNode: ContractNode;
  speakerColor: string;
  isActiveSpeaker: boolean;
  isGhostResolution: boolean;
};

/**
 * Committed graph node. Tasteful 8px radius, subtle inner gradient,
 * outer glow box-shadow tinted by speaker color (never a flat border).
 * Importance maps to scale via spring. Hover lifts. The ghost→solid
 * morph is wired via a shared `layoutId`.
 */
export function SolidNode(props: NodeProps<SolidNodeData>) {
  const { contractNode: node, speakerColor, isActiveSpeaker, isGhostResolution } = props.data;
  const reduce = useReducedMotion();

  const importance = Math.max(0, Math.min(1, node.importance_score));
  const baseWidth = 168 + importance * 56;
  const layoutId = isGhostResolution ? `ghost-${node._id}-resolves` : undefined;

  const selectNode = useGraphStore((s) => s.selectNode);
  const hasInfo = node.info.length > 0;

  return (
    <motion.button
      layoutId={layoutId}
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        selectNode(node._id);
      }}
      initial={reduce ? false : { opacity: 0, scale: 0.5, filter: "blur(4px)" }}
      animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
      whileHover={reduce ? undefined : { y: -2, scale: 1.02 }}
      whileTap={reduce ? undefined : { scale: 0.98 }}
      transition={reduce ? { duration: 0 } : springEntrance}
      style={{
        width: baseWidth,
        boxShadow: isActiveSpeaker
          ? `0 0 0 1px ${speakerColor}, 0 0 0 4px ${speakerColor}24, 0 0 28px 4px ${speakerColor}55, 0 6px 18px rgba(0,0,0,0.55)`
          : `0 0 0 1px ${speakerColor}40, 0 0 16px 2px ${speakerColor}24, 0 4px 12px rgba(0,0,0,0.5)`,
        // CSS-var so the children can pick up the speaker color.
        ["--node-speaker" as string]: speakerColor,
      }}
      className="sn"
      aria-label={`Node: ${node.label}`}
    >
      <motion.div className="sn__body" transition={springTap}>
        {node.image_url ? (
          <motion.img
            src={node.image_url}
            alt=""
            className="sn__image"
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={springEntrance}
          />
        ) : null}
        <div className="sn__row">
          <span className="sn__dot" aria-hidden />
          <span className="sn__label" title={node.label}>
            {node.label}
          </span>
        </div>
        <div className="sn__footrow">
          {hasInfo ? (
            <span className="sn__chip">
              <span className="sn__chip-dot" />
              {node.info.length}
            </span>
          ) : null}
          <span className="sn__importance" aria-hidden>
            {Array.from({ length: 5 }).map((_, i) => (
              <span
                key={i}
                style={{
                  opacity: i < Math.round(importance * 5) ? 0.9 : 0.18,
                }}
              />
            ))}
          </span>
        </div>
      </motion.div>
      <Handle type="target" position={Position.Top} className="rf-handle" />
      <Handle type="source" position={Position.Bottom} className="rf-handle" />

      <style>{`
        .sn {
          position: relative;
          padding: 0;
          border-radius: 10px;
          background:
            linear-gradient(180deg,
              color-mix(in srgb, var(--bg-raised) 90%, var(--node-speaker)) 0%,
              var(--bg-raised) 60%,
              color-mix(in srgb, var(--bg-base) 92%, var(--node-speaker)) 100%);
          color: var(--text-primary);
          font-family: var(--font-display);
          text-align: left;
          will-change: transform, box-shadow;
        }
        .sn__body {
          display: flex;
          flex-direction: column;
          gap: 8px;
          padding: 12px 14px;
          min-height: 56px;
        }
        .sn__image {
          width: 100%;
          max-height: 80px;
          object-fit: cover;
          border-radius: 6px;
          margin-bottom: 4px;
        }
        .sn__row {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .sn__dot {
          width: 6px; height: 6px;
          border-radius: 999px;
          background: var(--node-speaker);
          box-shadow: 0 0 8px var(--node-speaker);
          flex-shrink: 0;
        }
        .sn__label {
          font-size: 13px;
          font-weight: 500;
          line-height: 1.25;
          color: var(--text-primary);
          letter-spacing: -0.005em;
          overflow: hidden;
          text-overflow: ellipsis;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
        }
        .sn__footrow {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .sn__chip {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          font-family: var(--font-mono);
          font-size: 10px;
          color: var(--text-tertiary);
          padding: 2px 6px;
          background: rgba(255,255,255,0.04);
          border-radius: 999px;
          font-variant-numeric: tabular-nums;
        }
        .sn__chip-dot {
          width: 4px; height: 4px;
          background: var(--signature-accent);
          border-radius: 999px;
          box-shadow: 0 0 6px var(--signature-accent-soft);
        }
        .sn__importance {
          display: inline-flex;
          gap: 2px;
        }
        .sn__importance > span {
          width: 14px;
          height: 2px;
          border-radius: 1px;
          background: var(--node-speaker);
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
