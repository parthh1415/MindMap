import { memo, useEffect, useMemo, useState } from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import type { Node as ContractNode } from "@shared/ws_messages";
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
 * Glowing-orb mindmap node — pure CSS, no framer-motion.
 *
 * This used to be a `motion.div` containing a `motion.button` with
 * `initial`/`animate`/`whileHover`/`whileTap` springs. Three nested
 * animation state machines (parent motion, child motion, framer-motion's
 * LayoutGroup) plus reactflow's own viewport transform created a race
 * during fast zoom/pan: the orb's effective transform could pass through
 * scale ≈ 0 mid-animation, the rasterizer would drop the layer, and the
 * orb stayed invisible until a layer-tree invalidation (window resize)
 * rebuilt it.
 *
 * The fix isn't to patch any single layer — it's to remove the layers
 * entirely. Hover, tap, dim, active-speaker, and the fresh-arrival
 * entrance are all CSS now. The orb is GUARANTEED to be visible whenever
 * it's mounted; there is no animation state that can land it at scale 0.
 *
 * Visual stack:
 *   .orb-core — radial-gradient sphere, three importance tiers via class.
 *   .orb-spec — drifting highlight (CSS keyframe, no JS state).
 *   .orb-core--pulse — one-shot ::after ripple ring on first arrival.
 *   .orb-core--enter — one-shot @keyframes scale-in for fresh arrivals.
 */
function SolidNodeImpl(props: NodeProps<SolidNodeData>) {
  const {
    contractNode: node,
    speakerColor,
    isActiveSpeaker,
    isGhostResolution,
    dimmed,
  } = props.data;

  // Defensive default: if the topology agent ever emits a node without
  // importance_score (or as null/NaN), Math.min/max propagate NaN and
  // `width: NaNpx` becomes a 0-width invisible orb. Default to 0.5 so
  // the orb still renders mid-tier.
  const rawImp = node.importance_score;
  const importance = Number.isFinite(rawImp)
    ? Math.max(0, Math.min(1, rawImp))
    : 0.5;
  const diameter = Math.round(14 + importance * 20); // 14 → 34px
  const tier = importance < 0.4 ? "leaf" : importance < 0.75 ? "branch" : "root";

  // ghost-resolution morph: the previous version used framer-motion's
  // layoutId for a shared-element transition. Without framer-motion that
  // morph is gone — the ghost simply fades and the solid fades in. Worth
  // it; the morph was nice-to-have, the visibility bug was unacceptable.
  // (We still expose data-resolves-from in case we want to re-add the
  // morph via a CSS view-transition later.)
  const resolvesFrom = isGhostResolution
    ? `ghost-${node._id}-resolves`
    : undefined;

  const selectNode = useGraphStore((s) => s.selectNode);

  // animationQueue holds node ids that *just* arrived from the topology
  // agent. Read once at mount; if our id is in it, drop into both the
  // bloom-in and the ripple-pulse classes for ~1.4 s, then clear.
  const queuedOnMount = useMemo(() => {
    return useGraphStore.getState().animationQueue.includes(node._id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [pulsing, setPulsing] = useState(queuedOnMount);
  useEffect(() => {
    if (!pulsing) return;
    const t = window.setTimeout(() => setPulsing(false), 1400);
    return () => window.clearTimeout(t);
  }, [pulsing]);

  return (
    <div
      className={`orb-wrap${dimmed ? " orb-wrap--dimmed" : ""}`}
      style={
        {
          ["--sc"]: speakerColor,
          ["--diam"]: `${diameter}px`,
        } as React.CSSProperties
      }
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          selectNode(node._id);
        }}
        className={[
          "orb-core",
          `orb-core--${tier}`,
          isActiveSpeaker ? "orb-core--active" : "",
          pulsing ? "orb-core--enter orb-core--pulse" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        aria-label={`Node: ${node.label}`}
        data-resolves-from={resolvesFrom}
      >
        <span className="orb-spec" aria-hidden />
      </button>

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
             centre, not the wrap's top edge. */
          transform: translate(-50%, -50%);
          padding-bottom: 18px;
          /* Dim transitions through CSS — no JS animation state involved.
             Floor is 0.22, never zero, so the orb is ALWAYS visible. */
          opacity: 1;
          transition: opacity 180ms ease-out;
        }
        .orb-wrap--dimmed { opacity: 0.22; }

        .orb-core {
          position: relative;
          width: var(--diam);
          height: var(--diam);
          padding: 0;
          border: none;
          border-radius: 999px;
          flex-shrink: 0;
          cursor: pointer;
          background:
            radial-gradient(
              circle at 32% 30%,
              color-mix(in srgb, var(--sc) 35%, #ffffff) 0%,
              color-mix(in srgb, var(--sc) 75%, #ffffff 0%) 38%,
              var(--sc) 78%,
              color-mix(in srgb, var(--sc) 80%, #000000) 100%
            );
          /* Hover/tap done in CSS. The base scale is ALWAYS 1 — there
             is no transient state where it could be 0. */
          transform: scale(1);
          transition: transform 160ms cubic-bezier(0.2, 0.8, 0.2, 1);
        }
        .orb-core:hover { transform: scale(1.18); }
        .orb-core:active { transform: scale(0.94); }

        /* Three tiers of bloom — static box-shadow stacks. */
        .orb-core--leaf {
          box-shadow:
            0 0 6px color-mix(in srgb, var(--sc) 35%, transparent),
            0 0 14px color-mix(in srgb, var(--sc) 18%, transparent);
        }
        .orb-core--branch {
          box-shadow:
            0 0 8px color-mix(in srgb, var(--sc) 50%, transparent),
            0 0 20px color-mix(in srgb, var(--sc) 28%, transparent),
            0 0 38px color-mix(in srgb, var(--sc) 12%, transparent);
        }
        .orb-core--root {
          box-shadow:
            0 0 10px color-mix(in srgb, var(--sc) 65%, transparent),
            0 0 28px color-mix(in srgb, var(--sc) 38%, transparent),
            0 0 56px color-mix(in srgb, var(--sc) 18%, transparent);
        }

        /* Active-speaker breath via CSS keyframe. */
        .orb-core--active {
          animation: orb-breath 1.8s ease-in-out infinite;
        }
        @keyframes orb-breath {
          0%, 100% {
            box-shadow:
              0 0 10px color-mix(in srgb, var(--sc) 50%, transparent),
              0 0 26px color-mix(in srgb, var(--sc) 30%, transparent);
          }
          50% {
            box-shadow:
              0 0 14px color-mix(in srgb, var(--sc) 80%, transparent),
              0 0 44px color-mix(in srgb, var(--sc) 50%, transparent),
              0 0 76px color-mix(in srgb, var(--sc) 24%, transparent);
          }
        }

        /* Fresh-arrival entrance: scale-in via @keyframes (fills 'forwards'
           so the orb LANDS at scale:1 and stays there — no transient zero
           state if the orb re-mounts mid-animation, because the keyframes
           don't loop). Only attached when the node was in animationQueue
           at first mount. */
        .orb-core--enter {
          animation:
            orb-enter 360ms cubic-bezier(0.34, 1.56, 0.64, 1) both,
            orb-breath 1.8s ease-in-out infinite 360ms;
        }
        @keyframes orb-enter {
          0%   { transform: scale(0);   opacity: 0; }
          60%  { transform: scale(1.12); opacity: 1; }
          100% { transform: scale(1);   opacity: 1; }
        }

        .orb-spec {
          position: absolute;
          top: 14%;
          left: 22%;
          width: 32%;
          height: 28%;
          border-radius: 999px;
          background: radial-gradient(
            circle at 50% 50%,
            rgba(255,255,255,0.85) 0%,
            rgba(255,255,255,0.25) 45%,
            transparent 75%
          );
          pointer-events: none;
          animation: orb-spec-drift 7.5s ease-in-out infinite alternate;
        }

        .orb-core--pulse::after {
          content: "";
          position: absolute;
          inset: -2px;
          border-radius: 999px;
          border: 1.5px solid color-mix(in srgb, var(--sc) 80%, white);
          pointer-events: none;
          animation: orb-pulse 1.2s ease-out forwards;
        }
        @keyframes orb-pulse {
          0%   { transform: scale(0.9); opacity: 0.85; }
          70%  { transform: scale(2.2); opacity: 0.0; }
          100% { transform: scale(2.4); opacity: 0; }
        }
        @keyframes orb-spec-drift {
          0%   { transform: translate(0, 0)        scale(1);    opacity: 0.95; }
          50%  { transform: translate(8%, -6%)     scale(1.05); opacity: 0.7;  }
          100% { transform: translate(-4%, 10%)    scale(0.95); opacity: 0.95; }
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
          text-shadow: 0 1px 4px rgba(0,0,0,0.85);
        }
        .rf-handle {
          width: 1px;
          height: 1px;
          background: transparent;
          border: none;
          opacity: 0;
        }
        @media (prefers-reduced-motion: reduce) {
          .orb-spec,
          .orb-core--active,
          .orb-core--enter,
          .orb-core--pulse::after { animation: none; }
          .orb-core { transition: none; }
          .orb-wrap { transition: none; }
        }
      `}</style>
    </div>
  );
}

/**
 * React.memo with a value comparator on the visual fields. reactflow
 * passes fresh `data` object literals every tick (positions update),
 * so without this each orb re-renders its full body 60×/sec during
 * streaming generation.
 */
export const SolidNode = memo(SolidNodeImpl, (prev, next) => {
  if (prev.id !== next.id) return false;
  const a = prev.data;
  const b = next.data;
  return (
    a.speakerColor === b.speakerColor &&
    a.isActiveSpeaker === b.isActiveSpeaker &&
    a.isGhostResolution === b.isGhostResolution &&
    a.dimmed === b.dimmed &&
    a.contractNode._id === b.contractNode._id &&
    a.contractNode.label === b.contractNode.label &&
    a.contractNode.importance_score === b.contractNode.importance_score &&
    a.contractNode.speaker_id === b.contractNode.speaker_id &&
    a.contractNode.updated_at === b.contractNode.updated_at
  );
});

export default SolidNode;
