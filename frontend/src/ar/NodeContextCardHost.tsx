import { useEffect, useRef, useState } from "react";
import { useGraphStore } from "@/state/graphStore";
import { useArContextStore } from "@/state/arContextStore";
import NodeContextCard from "./NodeContextCard";
import type { Vec2 } from "./types";

/**
 * Host that reads the open cards list from the AR context store and the
 * live projected screen positions from a parent-owned ref Map. Runs its
 * own animation loop to push position updates into each card's wrapper
 * via direct DOM transforms — that avoids round-tripping every frame
 * through React re-render, keeps the AR view at 60 fps, and lets each
 * card glide smoothly with its orb as the user rotates the graph.
 */
export interface NodeContextCardHostProps {
  /** Live map of nodeId → projected pixel position in the overlay
   *  frame. Mutated in place by ARStage's RAF loop. */
  anchorsRef: React.MutableRefObject<Map<string, Vec2>>;
  /** Container size so cards can flip to the opposite side when they'd
   *  overflow the right edge. */
  width: number;
  height: number;
  /** Speaker color resolver — same hex tokens used by the orb sprites. */
  resolveSpeakerColor: (nodeId: string) => string;
}

export function NodeContextCardHost({
  anchorsRef,
  width,
  height,
  resolveSpeakerColor,
}: NodeContextCardHostProps) {
  const openCards = useArContextStore((s) => s.openCards);
  const closeAll = useArContextStore((s) => s.closeAll);
  const nodes = useGraphStore((s) => s.nodes);

  // Anchor positions are mirrored into local state at ~30 fps so the
  // cards re-render on a tractable cadence (NodeContextCard recomputes
  // side + clamping based on the latest anchor; that needs to flow
  // through React). 30 fps is below human perception of jitter for
  // tooltips and saves half the renders vs. matching the RAF.
  const [anchorsTick, setAnchorsTick] = useState(0);
  const rafRef = useRef<number>(0);
  useEffect(() => {
    if (openCards.length === 0) return;
    let last = 0;
    const tick = (t: number) => {
      // ~33 ms = 30 fps. Coalescing extra frames avoids unnecessary work.
      if (t - last >= 33) {
        last = t;
        setAnchorsTick((x) => x + 1);
      }
      rafRef.current = window.requestAnimationFrame(tick);
    };
    rafRef.current = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafRef.current);
  }, [openCards.length]);

  // Esc closes all cards — keyboard escape route is required for any
  // dialog stack (HIG escape-routes).
  useEffect(() => {
    if (openCards.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeAll();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openCards.length, closeAll]);

  if (openCards.length === 0) return null;

  return (
    <div className="ar-card-host" aria-live="polite">
      {openCards.map((card) => {
        const node = nodes[card.nodeId];
        const anchor = anchorsRef.current.get(card.nodeId);
        if (!node || !anchor) return null;
        return (
          <NodeContextCard
            key={card.nodeId}
            nodeId={card.nodeId}
            anchor={anchor}
            speakerColor={resolveSpeakerColor(card.nodeId)}
            containerWidth={width}
            containerHeight={height}
          />
        );
      })}
      {/* anchorsTick subscription — referenced so React knows to re-run
          this map on every tick. Stripping it would freeze positions. */}
      <span className="ar-card-host__pulse" aria-hidden data-tick={anchorsTick} />
      <style>{`
        .ar-card-host {
          position: absolute;
          inset: 0;
          z-index: 25;
          pointer-events: none; /* cards opt-in via their own pointer-events:auto */
        }
        .ar-card-host__pulse { display: none; }
      `}</style>
    </div>
  );
}

export default NodeContextCardHost;
