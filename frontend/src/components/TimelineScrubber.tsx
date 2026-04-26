import { motion, useReducedMotion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { Radio } from "lucide-react";
import dayjs from "dayjs";
import useMeasure from "react-use-measure";
import { useGraphStore, useNodeList } from "@/state/graphStore";
import { useSessionStore } from "@/state/sessionStore";
import BranchButton from "./BranchButton";

/**
 * Horizontal scrubber pinned to the bottom edge.
 *
 * - Range: session start → "now" (or last node creation time, whichever is later)
 * - Tick marks: density of node creations across the timeline
 * - Drag updates an internal pointer; debounced fetch hits
 *   GET /sessions/{id}/graph?at=ISO and applies a snapshot via
 *   graphStore.setTimelineSnapshot — graph nodes spring-tween between snapshots.
 * - "Live" pill with soft pulsing glow when in live mode.
 * - Tabular numerals on time display.
 */
export function TimelineScrubber() {
  const sessionId = useSessionStore((s) => s.currentSessionId);
  const timelineMode = useGraphStore((s) => s.timelineMode);
  const goLive = useGraphStore((s) => s.goLive);
  const nodes = useNodeList();
  const reduceMotion = useReducedMotion();

  const [trackRef, trackBounds] = useMeasure();
  const trackEl = useRef<HTMLDivElement>(null);
  const [dragX, setDragX] = useState<number | null>(null);

  // Compute time range from node timestamps.
  // The timeline edge is intentionally a fresh wall-clock on every render
  // so the "now" tick stays current while the panel is visible. This is
  // observably correct (a few ms of skew is invisible), and we keep the
  // useMemo below pure by capturing the timestamp once at render.
  // eslint-disable-next-line react-hooks/purity
  const renderTime = Date.now();
  const range = useMemo(() => {
    if (nodes.length === 0) {
      return { start: renderTime - 60_000, end: renderTime };
    }
    let min = Infinity;
    let max = -Infinity;
    for (const n of nodes) {
      const t = new Date(n.created_at).getTime();
      if (t < min) min = t;
      if (t > max) max = t;
    }
    return {
      start: Math.min(min, renderTime - 30_000),
      end: Math.max(max, renderTime),
    };
  }, [nodes, renderTime]);

  const ticks = useMemo(() => {
    if (trackBounds.width <= 0) return [];
    const span = Math.max(1, range.end - range.start);
    return nodes.map((n) => {
      const t = new Date(n.created_at).getTime();
      return ((t - range.start) / span) * trackBounds.width;
    });
  }, [nodes, range, trackBounds.width]);

  const playheadX = useMemo(() => {
    if (trackBounds.width <= 0) return 0;
    const span = Math.max(1, range.end - range.start);
    if (timelineMode.active) {
      const t = new Date(timelineMode.atTimestamp).getTime();
      return ((t - range.start) / span) * trackBounds.width;
    }
    return trackBounds.width;
  }, [timelineMode, range, trackBounds.width]);

  // Debounced snapshot fetch on drag.
  useEffect(() => {
    if (dragX === null || !sessionId || trackBounds.width <= 0) return;
    const span = Math.max(1, range.end - range.start);
    const ts = new Date(range.start + (dragX / trackBounds.width) * span).toISOString();
    const id = window.setTimeout(async () => {
      try {
        const url = `${import.meta.env.VITE_BACKEND_URL ?? ""}/sessions/${sessionId}/graph?at=${encodeURIComponent(ts)}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as {
          nodes: import("@shared/ws_messages").Node[];
          edges: import("@shared/ws_messages").Edge[];
        };
        useGraphStore.getState().setTimelineSnapshot(data.nodes, data.edges, ts);
      } catch (err) {
        console.warn("[scrubber] snapshot fetch failed", err);
      }
    }, 120);
    return () => window.clearTimeout(id);
  }, [dragX, sessionId, range.end, range.start, trackBounds.width]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = trackEl.current?.getBoundingClientRect();
    if (!rect) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragX(Math.max(0, Math.min(rect.width, e.clientX - rect.left)));
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragX === null) return;
    const rect = trackEl.current?.getBoundingClientRect();
    if (!rect) return;
    setDragX(Math.max(0, Math.min(rect.width, e.clientX - rect.left)));
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.releasePointerCapture(e.pointerId);
    setDragX(null);
  };

  // Show the time the user is currently *targeting* — during a drag,
  // that's the pixel position; otherwise it's the past snapshot timestamp
  // (timeline mode) or the live edge.
  const pillTimeLabel = (() => {
    if (dragX !== null && trackBounds.width > 0) {
      const span = Math.max(1, range.end - range.start);
      const t = range.start + (dragX / trackBounds.width) * span;
      return dayjs(t).format("HH:mm:ss");
    }
    if (timelineMode.active) return dayjs(timelineMode.atTimestamp).format("HH:mm:ss");
    return dayjs(range.end).format("HH:mm:ss");
  })();

  return (
    <div className="scrubber-shell glass-surface" role="region" aria-label="Timeline scrubber">
      <button
        type="button"
        className={`live-pill ${timelineMode.active ? "live-pill--past" : "live-pill--live"}`}
        onClick={() => timelineMode.active && goLive()}
        aria-pressed={!timelineMode.active}
        title={timelineMode.active ? "Return to live" : "Live (latest state)"}
      >
        {!timelineMode.active ? (
          <motion.span
            aria-hidden
            className="live-pill__dot"
            animate={
              reduceMotion
                ? undefined
                : { scale: [1, 1.35, 1], opacity: [1, 0.55, 1] }
            }
            transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
          />
        ) : (
          <Radio size={11} aria-hidden />
        )}
        <span className="live-pill__label">
          {!timelineMode.active ? "LIVE" : "PAST"}
        </span>
      </button>

      <span className="scrubber-time scrubber-time--start tabular" aria-hidden>
        {dayjs(range.start).format("HH:mm:ss")}
      </span>

      <div
        ref={(el) => {
          trackRef(el);
          trackEl.current = el;
        }}
        className="scrubber-track"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        role="slider"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={trackBounds.width > 0 ? Math.round((playheadX / trackBounds.width) * 100) : 100}
        aria-label="Scrub through session timeline"
      >
        {/* Played portion */}
        <div
          className="scrubber-fill"
          style={{ width: dragX !== null ? dragX : playheadX }}
        />
        {/* Node-creation density dots */}
        {ticks.map((x, i) => (
          <div key={i} className="scrubber-tick" style={{ left: x }} />
        ))}
        {/* Playhead — thin line with a grip dot above */}
        <motion.div
          className="scrubber-head"
          animate={{ x: dragX !== null ? dragX : playheadX }}
          transition={
            reduceMotion
              ? { duration: 0 }
              : { type: "spring", stiffness: 380, damping: 32 }
          }
        >
          <span className="scrubber-head__grip" aria-hidden />
        </motion.div>
      </div>

      <span className="scrubber-time scrubber-time--end tabular" aria-hidden>
        {pillTimeLabel}
      </span>

      <div className="scrubber-actions">
        <BranchButton />
      </div>

      <style>{`
        .scrubber-shell {
          position: absolute;
          left: 50%;
          bottom: var(--sp-5);
          transform: translateX(-50%);
          width: min(820px, calc(100vw - 64px));
          z-index: var(--z-scrubber);
          border-radius: var(--radius-pill);
          padding: 10px 14px;
          display: grid;
          grid-template-columns: auto auto 1fr auto auto;
          align-items: center;
          gap: var(--sp-3);
          /* Slightly stronger glass than the global helper so the chip
           * reads as a primary control surface against the canvas. */
          background: rgba(8, 12, 17, 0.72);
        }

        .live-pill {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 6px 11px;
          border-radius: var(--radius-pill);
          font-family: var(--font-display);
          font-size: var(--fs-xs);
          letter-spacing: 0.18em;
          font-weight: 600;
          line-height: 1;
          transition: background-color var(--motion-quick) ease,
                      box-shadow var(--motion-quick) ease,
                      color var(--motion-quick) ease;
          flex-shrink: 0;
        }
        .live-pill--live {
          background: var(--signature-accent);
          color: var(--signature-accent-fg);
          box-shadow:
            0 0 0 1px rgba(214, 255, 58, 0.7),
            0 0 22px rgba(214, 255, 58, 0.35);
          cursor: default;
        }
        .live-pill--past {
          background: var(--bg-overlay);
          color: var(--text-secondary);
          box-shadow: 0 0 0 1px var(--border-default);
        }
        .live-pill--past:hover {
          color: var(--text-primary);
          background: var(--bg-elevated);
          box-shadow: 0 0 0 1px var(--border-strong);
        }
        .live-pill__dot {
          display: inline-block;
          width: 6px;
          height: 6px;
          border-radius: 999px;
          background: var(--signature-accent-fg);
          box-shadow: 0 0 6px rgba(0, 0, 0, 0.35) inset;
        }
        .live-pill__label {
          font-variant-numeric: tabular-nums;
        }

        .scrubber-time {
          font-family: var(--font-mono);
          font-size: 10px;
          font-weight: 500;
          letter-spacing: 0.04em;
          color: var(--text-tertiary);
          white-space: nowrap;
          flex-shrink: 0;
        }
        .scrubber-time--end {
          color: var(--signature-accent);
          opacity: 0.78;
        }

        .scrubber-track {
          position: relative;
          height: 22px;
          cursor: ew-resize;
          touch-action: none;
          /* The visible bar is centered inside a taller hit area so the
           * track is easier to grab without crowding the chip. */
          display: flex;
          align-items: center;
        }
        .scrubber-track::before {
          /* The bar itself */
          content: "";
          position: absolute;
          left: 0;
          right: 0;
          height: 4px;
          border-radius: var(--radius-pill);
          background: linear-gradient(
            90deg,
            rgba(255, 255, 255, 0.04) 0%,
            rgba(255, 255, 255, 0.10) 50%,
            rgba(255, 255, 255, 0.04) 100%
          );
          box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.04);
        }
        .scrubber-fill {
          position: absolute;
          left: 0;
          height: 4px;
          border-radius: var(--radius-pill);
          background: linear-gradient(
            90deg,
            rgba(214, 255, 58, 0.0),
            rgba(214, 255, 58, 0.55) 60%,
            rgba(214, 255, 58, 0.85)
          );
          pointer-events: none;
          box-shadow: 0 0 14px rgba(214, 255, 58, 0.32);
          transition: width 90ms linear;
        }
        .scrubber-tick {
          position: absolute;
          top: 50%;
          width: 2px;
          height: 2px;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.45);
          transform: translate(-50%, -50%);
          pointer-events: none;
          mix-blend-mode: screen;
        }
        .scrubber-head {
          position: absolute;
          top: 0;
          bottom: 0;
          width: 2px;
          background: var(--signature-accent);
          box-shadow: 0 0 10px var(--signature-accent-glow);
          pointer-events: none;
          margin-left: -1px; /* center the 2px line on the position */
          transform-origin: 50% 50%;
        }
        .scrubber-head__grip {
          position: absolute;
          top: -3px;
          left: 50%;
          width: 9px;
          height: 9px;
          border-radius: 999px;
          background: var(--signature-accent);
          transform: translateX(-50%);
          box-shadow:
            0 0 0 2px rgba(6, 9, 13, 0.85),
            0 0 12px var(--signature-accent-glow);
        }

        .scrubber-actions {
          display: flex;
          align-items: center;
          flex-shrink: 0;
        }

        @media (max-width: 640px) {
          .scrubber-shell {
            width: calc(100vw - 32px);
            grid-template-columns: auto 1fr auto auto;
            gap: var(--sp-2);
            padding: 8px 12px;
          }
          .scrubber-time--start {
            display: none;
          }
        }
      `}</style>
    </div>
  );
}

export default TimelineScrubber;
