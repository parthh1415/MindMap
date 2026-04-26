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

  const pillTimeLabel = timelineMode.active
    ? dayjs(timelineMode.atTimestamp).format("HH:mm:ss")
    : dayjs(range.end).format("HH:mm:ss");

  return (
    <div className="scrubber-shell" role="region" aria-label="Timeline scrubber">
      <div className="scrubber-times tabular">
        <span>{dayjs(range.start).format("HH:mm:ss")}</span>
        <button
          type="button"
          className={`live-pill ${timelineMode.active ? "live-pill--past" : "live-pill--live"}`}
          onClick={() => timelineMode.active && goLive()}
          aria-pressed={!timelineMode.active}
        >
          {!timelineMode.active ? (
            <motion.span
              aria-hidden
              className="live-pill__dot"
              animate={
                reduceMotion
                  ? undefined
                  : { scale: [1, 1.4, 1], opacity: [1, 0.6, 1] }
              }
              transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
            />
          ) : (
            <Radio size={12} />
          )}
          <span className="tabular">{!timelineMode.active ? "LIVE" : "PAST"}</span>
          <span className="live-pill__time tabular">{pillTimeLabel}</span>
        </button>
        <span>{dayjs(range.end).format("HH:mm:ss")}</span>
      </div>

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
      >
        {/* Filled portion gradient */}
        <div
          className="scrubber-fill"
          style={{
            width: dragX !== null ? dragX : playheadX,
          }}
        />
        {/* Tick marks for node-creation density */}
        {ticks.map((x, i) => (
          <div key={i} className="scrubber-tick" style={{ left: x }} />
        ))}
        {/* Playhead */}
        <motion.div
          className="scrubber-head"
          animate={{ x: dragX !== null ? dragX : playheadX }}
          transition={
            reduceMotion
              ? { duration: 0 }
              : { type: "spring", stiffness: 360, damping: 30 }
          }
        />
      </div>

      <div className="scrubber-actions">
        <BranchButton />
      </div>

      <style>{`
        .scrubber-shell {
          position: absolute;
          left: 50%;
          bottom: var(--space-5);
          transform: translateX(-50%);
          width: min(880px, calc(100vw - 64px));
          z-index: var(--z-scrubber);
          background: rgba(15, 23, 42, 0.7);
          backdrop-filter: blur(12px);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-lg);
          padding: var(--space-3) var(--space-4);
          box-shadow: var(--elev-3);
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
        }
        .scrubber-times {
          display: flex;
          align-items: center;
          justify-content: space-between;
          font-size: var(--font-size-xs);
          color: var(--text-tertiary);
          font-feature-settings: "tnum" 1;
        }
        .live-pill {
          display: inline-flex;
          align-items: center;
          gap: var(--space-2);
          padding: var(--space-1) var(--space-3);
          border-radius: var(--radius-pill);
          font-family: var(--font-display);
          font-size: var(--font-size-xs);
          letter-spacing: 0.12em;
          font-weight: 600;
        }
        .live-pill--live {
          background: rgba(34, 211, 238, 0.12);
          color: var(--signature-accent);
          box-shadow: 0 0 0 1px var(--signature-accent-soft), 0 0 18px var(--signature-accent-glow);
        }
        .live-pill--past {
          background: var(--bg-overlay);
          color: var(--text-secondary);
        }
        .live-pill__dot {
          display: inline-block;
          width: 8px;
          height: 8px;
          border-radius: 999px;
          background: var(--signature-accent);
          box-shadow: 0 0 8px var(--signature-accent-glow);
        }
        .live-pill__time {
          color: var(--text-secondary);
          font-feature-settings: "tnum" 1;
        }
        .scrubber-track {
          position: relative;
          height: 32px;
          background:
            /* film-strip hairlines every 4px for that oscilloscope/strip feel */
            repeating-linear-gradient(
              90deg,
              rgba(255,255,255,0.05) 0px,
              rgba(255,255,255,0.05) 1px,
              transparent 1px,
              transparent 4px
            ),
            linear-gradient(180deg,
              color-mix(in srgb, var(--bg-base) 96%, var(--signature-accent)) 0%,
              var(--bg-base) 100%);
          border-radius: 6px;
          cursor: ew-resize;
          overflow: hidden;
          border: 1px solid var(--border-subtle);
          box-shadow: inset 0 0 0 1px rgba(255,255,255,0.02);
        }
        .scrubber-fill {
          position: absolute;
          left: 0;
          top: 0;
          bottom: 0;
          background:
            linear-gradient(90deg,
              color-mix(in srgb, var(--signature-accent) 8%, transparent),
              color-mix(in srgb, var(--signature-accent) 32%, transparent));
          mix-blend-mode: screen;
          pointer-events: none;
        }
        .scrubber-tick {
          position: absolute;
          top: 6px;
          bottom: 6px;
          width: 1px;
          background: rgba(248, 250, 252, 0.18);
          pointer-events: none;
        }
        .scrubber-head {
          position: absolute;
          top: -4px;
          bottom: -4px;
          width: 2px;
          background: var(--signature-accent);
          box-shadow: 0 0 12px var(--signature-accent-glow);
          pointer-events: none;
        }
        .scrubber-actions {
          display: flex;
          justify-content: flex-end;
        }
      `}</style>
    </div>
  );
}

export default TimelineScrubber;
