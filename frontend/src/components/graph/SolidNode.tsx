import { motion, useReducedMotion } from "framer-motion";
import { Handle, Position, type NodeProps } from "reactflow";
import type { Node as ContractNode } from "@shared/ws_messages";
import { springEntrance } from "@/lib/motion";
import { useGraphStore } from "@/state/graphStore";

export type SolidNodeData = {
  contractNode: ContractNode;
  speakerColor: string;
  isActiveSpeaker: boolean;
  isGhostResolution: boolean;
};

/**
 * Committed graph node, rendered as a real circular mind-map node.
 * Diameter scales with importance (96px → 160px). Label is centered
 * inside; if it's longer than ~14 chars it wraps to two lines and the
 * font shrinks. Speaker color drives an outer glow box-shadow (NOT a
 * flat border) and a 1px inner ring. The ghost→solid morph is wired
 * via a shared `layoutId` (`ghost-<id>-resolves`).
 */
export function SolidNode(props: NodeProps<SolidNodeData>) {
  const { contractNode: node, speakerColor, isActiveSpeaker, isGhostResolution } = props.data;
  const reduce = useReducedMotion();

  const importance = Math.max(0, Math.min(1, node.importance_score));
  const diameter = Math.round(96 + importance * 64); // 96 → 160px
  const layoutId = isGhostResolution ? `ghost-${node._id}-resolves` : undefined;

  const selectNode = useGraphStore((s) => s.selectNode);
  const hasInfo = node.info.length > 0;

  // Label sizing
  const long = node.label.length > 14;
  const labelFontSize = long ? 12 : 14;

  return (
    <motion.button
      layoutId={layoutId}
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        selectNode(node._id);
      }}
      initial={reduce ? false : { opacity: 0, scale: 0.4, filter: "blur(6px)" }}
      animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
      whileHover={reduce ? undefined : { y: -3, scale: 1.04 }}
      whileTap={reduce ? undefined : { scale: 0.96 }}
      transition={reduce ? { duration: 0 } : springEntrance}
      style={{
        width: diameter,
        height: diameter,
        boxShadow: isActiveSpeaker
          ? `0 0 0 1px ${speakerColor}, 0 0 0 5px ${speakerColor}25, 0 0 36px 6px ${speakerColor}50, 0 8px 24px rgba(0,0,0,0.6)`
          : `0 0 0 1px ${speakerColor}55, 0 0 22px 4px ${speakerColor}28, 0 4px 16px rgba(0,0,0,0.55)`,
        ["--node-speaker" as string]: speakerColor,
      }}
      className="sn"
      aria-label={`Node: ${node.label}`}
    >
      {hasInfo ? (
        <span className="sn__info-badge tabular" aria-label={`${node.info.length} notes`}>
          {node.info.length}
        </span>
      ) : null}

      {node.image_url ? (
        <motion.div
          className="sn__image-ring"
          aria-hidden
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={springEntrance}
          style={{ backgroundImage: `url(${node.image_url})` }}
        />
      ) : null}

      <span
        className="sn__label"
        title={node.label}
        style={{ fontSize: labelFontSize }}
      >
        {node.label}
      </span>

      <span className="sn__importance" aria-hidden>
        {Array.from({ length: 5 }).map((_, i) => (
          <span
            key={i}
            style={{
              opacity: i < Math.round(importance * 5) ? 0.95 : 0.18,
            }}
          />
        ))}
      </span>

      <Handle type="target" position={Position.Top} className="rf-handle" />
      <Handle type="source" position={Position.Bottom} className="rf-handle" />

      <style>{`
        .sn {
          position: relative;
          padding: 0;
          border-radius: 999px;
          background:
            radial-gradient(circle at 30% 28%,
              color-mix(in srgb, var(--bg-raised) 70%, var(--node-speaker)) 0%,
              var(--bg-raised) 55%,
              color-mix(in srgb, var(--bg-base) 88%, var(--node-speaker)) 100%);
          color: var(--text-primary);
          font-family: var(--font-display);
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 6px;
          padding: 10px 14px;
          will-change: transform, box-shadow;
          overflow: hidden;
        }
        .sn__image-ring {
          position: absolute;
          inset: 6px;
          border-radius: 999px;
          background-size: cover;
          background-position: center;
          opacity: 0.85;
          mix-blend-mode: luminosity;
        }
        .sn__info-badge {
          position: absolute;
          top: 8px;
          right: 8px;
          min-width: 18px; height: 18px;
          padding: 0 6px;
          border-radius: 999px;
          background: var(--signature-accent);
          color: var(--signature-accent-fg);
          font-family: var(--font-mono);
          font-size: 10px;
          font-weight: 700;
          display: grid;
          place-items: center;
          font-variant-numeric: tabular-nums;
          box-shadow: 0 0 10px var(--signature-accent-glow);
        }
        .sn__label {
          position: relative;
          font-weight: 500;
          line-height: 1.18;
          color: var(--text-primary);
          text-align: center;
          letter-spacing: -0.005em;
          padding: 0 4px;
          max-width: 90%;
          overflow: hidden;
          text-overflow: ellipsis;
          display: -webkit-box;
          -webkit-line-clamp: 3;
          -webkit-box-orient: vertical;
          word-break: break-word;
          z-index: 1;
        }
        .sn__importance {
          position: relative;
          display: inline-flex;
          gap: 2px;
          z-index: 1;
        }
        .sn__importance > span {
          width: 8px;
          height: 2px;
          border-radius: 1px;
          background: var(--node-speaker);
        }
        .rf-handle {
          width: 4px;
          height: 4px;
          background: transparent;
          border: none;
          opacity: 0;
        }
      `}</style>
    </motion.button>
  );
}

export default SolidNode;
