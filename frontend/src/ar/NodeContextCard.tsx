import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { useGraphStore } from "@/state/graphStore";
import { useArContextStore } from "@/state/arContextStore";
import type { Vec2 } from "./types";

/**
 * Floating context card anchored to a 3D orb's projected screen
 * position. Renders the node's enriched bullets (`info[]`) — the
 * agent-summarised context for the topic — in glassmorphic UI that
 * matches the rest of the chrome. Position is updated by ARStage's RAF
 * loop via a parent-controlled pixel offset; this component itself
 * doesn't read the scene.
 *
 * Interaction:
 *   - Header close button dismisses the card.
 *   - Tap outside anywhere → handled by the AR canvas dismissing all
 *     cards (so the gesture stays usable in headless / one-hand mode).
 *
 * Accessibility:
 *   - role=dialog, aria-labelledby on the title, focus trap on open,
 *     Esc closes (handled at the host level).
 */
export interface NodeContextCardProps {
  nodeId: string;
  /** Projected pixel position of the orb in the overlay frame. The card
   *  positions its anchor here and then offsets itself so the bubble
   *  doesn't cover the orb. Updated every animation frame. */
  anchor: Vec2;
  /** Speaker color hex, used for the accent stripe. */
  speakerColor: string;
  /** Optional: container width — used to flip the card to the LEFT
   *  side of the orb when it would otherwise clip the right edge. */
  containerWidth: number;
  containerHeight: number;
}

const CARD_WIDTH = 296;
const CARD_GUTTER = 16;
const ORB_OFFSET = 22; // px from anchor before the bubble starts

export function NodeContextCard({
  nodeId,
  anchor,
  speakerColor,
  containerWidth,
  containerHeight,
}: NodeContextCardProps) {
  const reduce = useReducedMotion();
  const node = useGraphStore((s) => s.nodes[nodeId]);
  const closeCard = useArContextStore((s) => s.closeCard);
  const cardRef = useRef<HTMLDivElement | null>(null);

  // Decide which side of the orb to anchor on based on available space.
  // Default right; flip left if the card would overflow the viewport.
  const wouldOverflowRight = anchor.x + ORB_OFFSET + CARD_WIDTH + CARD_GUTTER > containerWidth;
  const side: "left" | "right" = wouldOverflowRight ? "left" : "right";
  // Vertical clamp — card top should never go above the safe gutter,
  // and its bottom should never fall below the safe gutter.
  const cardTop = clamp(anchor.y - 60, CARD_GUTTER, Math.max(CARD_GUTTER, containerHeight - 240));
  const cardLeft =
    side === "right"
      ? anchor.x + ORB_OFFSET
      : anchor.x - ORB_OFFSET - CARD_WIDTH;

  // Pull bullets — newest first (they're appended chronologically).
  const bullets = useMemo(() => {
    if (!node) return [] as string[];
    const items = (node.info ?? []).slice().reverse();
    // Trim to the first 5 distinct entries to keep the card scannable.
    const out: string[] = [];
    const seen = new Set<string>();
    for (const it of items) {
      const t = it.text.trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
      if (out.length >= 5) break;
    }
    return out;
  }, [node]);

  // Local "filling in context" affordance — true while the agent has
  // not yet enriched this node and we have nothing to show. Clears once
  // bullets arrive (the store updates via WebSocket node_enriched).
  const [waitedAtLeast, setWaitedAtLeast] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setWaitedAtLeast(true), 500);
    return () => window.clearTimeout(t);
  }, []);

  if (!node) return null;

  return (
    <AnimatePresence>
      <motion.div
        key={nodeId}
        ref={cardRef}
        role="dialog"
        aria-labelledby={`ar-card-title-${nodeId}`}
        className="ar-context-card"
        style={
          {
            ["--ar-card-accent" as string]: speakerColor,
            top: cardTop,
            left: cardLeft,
            width: CARD_WIDTH,
          } as React.CSSProperties
        }
        initial={
          reduce
            ? { opacity: 1, scale: 1, x: 0 }
            : {
                opacity: 0,
                scale: 0.92,
                x: side === "right" ? -8 : 8,
              }
        }
        animate={{ opacity: 1, scale: 1, x: 0 }}
        exit={
          reduce
            ? { opacity: 0 }
            : {
                opacity: 0,
                scale: 0.96,
                x: side === "right" ? -6 : 6,
                transition: { duration: 0.15, ease: "easeIn" },
              }
        }
        transition={
          reduce
            ? { duration: 0 }
            : { type: "spring", stiffness: 320, damping: 30, mass: 0.9 }
        }
      >
        <div className="ar-context-card__head">
          <span className="ar-context-card__dot" aria-hidden />
          <h3
            id={`ar-card-title-${nodeId}`}
            className="ar-context-card__title"
            title={node.label}
          >
            {node.label.replace(/^\[[A-Z]+\]\s*/, "")}
          </h3>
          <button
            type="button"
            className="ar-context-card__close"
            aria-label="Close context card"
            onClick={() => closeCard(nodeId)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
              <path
                d="M6 6 L18 18 M18 6 L6 18"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                fill="none"
              />
            </svg>
          </button>
        </div>

        {bullets.length > 0 ? (
          <ul className="ar-context-card__list">
            {bullets.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        ) : waitedAtLeast ? (
          <p className="ar-context-card__empty">
            <span className="ar-context-card__shimmer" aria-hidden />
            Filling in context — the topic is still being enriched from
            the conversation.
          </p>
        ) : (
          <div className="ar-context-card__skeleton" aria-hidden>
            <span /> <span /> <span />
          </div>
        )}

        <div className="ar-context-card__foot">
          <span className="ar-context-card__meta">
            {bullets.length > 0
              ? `${bullets.length} note${bullets.length === 1 ? "" : "s"}`
              : "no notes yet"}
          </span>
        </div>

        <style>{`
          .ar-context-card {
            position: absolute;
            z-index: 25;
            background: rgba(14, 16, 22, 0.78);
            border: 1px solid rgba(255, 255, 255, 0.10);
            border-radius: 14px;
            padding: 12px 14px 10px 14px;
            backdrop-filter: blur(18px) saturate(140%);
            -webkit-backdrop-filter: blur(18px) saturate(140%);
            box-shadow:
              0 10px 32px rgba(0, 0, 0, 0.55),
              0 0 0 1px rgba(255, 255, 255, 0.04) inset,
              0 0 18px color-mix(in srgb, var(--ar-card-accent) 18%, transparent);
            color: #f4f6fa;
            font-family: var(--font-body);
            pointer-events: auto;
          }
          .ar-context-card__head {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 8px;
          }
          .ar-context-card__dot {
            width: 8px;
            height: 8px;
            border-radius: 999px;
            background: var(--ar-card-accent);
            box-shadow: 0 0 10px color-mix(in srgb, var(--ar-card-accent) 70%, transparent);
            flex-shrink: 0;
          }
          .ar-context-card__title {
            flex: 1;
            font-family: var(--font-display);
            font-size: 14px;
            font-weight: 600;
            line-height: 1.25;
            letter-spacing: -0.005em;
            margin: 0;
            color: #f8faff;
            display: -webkit-box;
            -webkit-line-clamp: 2;
            -webkit-box-orient: vertical;
            overflow: hidden;
          }
          .ar-context-card__close {
            flex-shrink: 0;
            width: 24px;
            height: 24px;
            border-radius: 6px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            color: rgba(244, 246, 250, 0.7);
            transition: background 0.18s ease, color 0.18s ease;
          }
          .ar-context-card__close:hover {
            background: rgba(255, 255, 255, 0.08);
            color: #ffffff;
          }
          .ar-context-card__close:focus-visible {
            outline: 2px solid var(--ar-card-accent);
            outline-offset: 2px;
          }
          .ar-context-card__list {
            list-style: none;
            padding: 0;
            margin: 0 0 8px 0;
            display: flex;
            flex-direction: column;
            gap: 6px;
          }
          .ar-context-card__list li {
            font-size: 12.5px;
            line-height: 1.45;
            color: rgba(244, 246, 250, 0.92);
            padding-left: 12px;
            position: relative;
          }
          .ar-context-card__list li::before {
            content: "";
            position: absolute;
            left: 2px;
            top: 8px;
            width: 4px;
            height: 4px;
            border-radius: 999px;
            background: color-mix(in srgb, var(--ar-card-accent) 70%, white);
            opacity: 0.85;
          }
          .ar-context-card__empty {
            font-size: 12.5px;
            line-height: 1.45;
            color: rgba(244, 246, 250, 0.72);
            margin: 0 0 8px 0;
            position: relative;
            padding-left: 18px;
          }
          .ar-context-card__shimmer {
            position: absolute;
            left: 2px;
            top: 6px;
            width: 10px;
            height: 10px;
            border-radius: 999px;
            background: color-mix(in srgb, var(--ar-card-accent) 50%, transparent);
            animation: ar-card-pulse 1.4s ease-in-out infinite;
          }
          @keyframes ar-card-pulse {
            0%, 100% { transform: scale(0.8); opacity: 0.6; }
            50% { transform: scale(1.1); opacity: 1; }
          }
          .ar-context-card__skeleton {
            display: flex;
            flex-direction: column;
            gap: 6px;
            margin-bottom: 8px;
          }
          .ar-context-card__skeleton span {
            display: block;
            height: 8px;
            border-radius: 999px;
            background: linear-gradient(
              90deg,
              rgba(255, 255, 255, 0.04) 0%,
              rgba(255, 255, 255, 0.12) 40%,
              rgba(255, 255, 255, 0.04) 80%
            );
            background-size: 220% 100%;
            animation: ar-card-shimmer 1.8s linear infinite;
          }
          .ar-context-card__skeleton span:nth-child(1) { width: 86%; }
          .ar-context-card__skeleton span:nth-child(2) { width: 72%; }
          .ar-context-card__skeleton span:nth-child(3) { width: 60%; }
          @keyframes ar-card-shimmer {
            0%   { background-position: 200% 0; }
            100% { background-position: -200% 0; }
          }
          .ar-context-card__foot {
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-top: 1px solid rgba(255, 255, 255, 0.06);
            padding-top: 6px;
          }
          .ar-context-card__meta {
            font-size: 10.5px;
            font-weight: 500;
            letter-spacing: 0.02em;
            text-transform: uppercase;
            color: rgba(244, 246, 250, 0.5);
          }
          @media (prefers-reduced-motion: reduce) {
            .ar-context-card__shimmer,
            .ar-context-card__skeleton span { animation: none; }
          }
        `}</style>
      </motion.div>
    </AnimatePresence>
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export default NodeContextCard;
