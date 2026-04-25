import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useState } from "react";
import { useGraphStore } from "@/state/graphStore";
import {
  useTranscriptHistory,
  useTranscriptPartials,
  useThinking,
  useTranscriptStore,
} from "@/state/transcriptStore";
import { useSessionStore } from "@/state/sessionStore";

/**
 * Live caption strip pinned just above the timeline scrubber. Shows
 * recent committed transcript lines + the in-flight partial(s) so the
 * user can verify the transcription is actually capturing what they
 * say. Without this, the only feedback was "did a node appear?" — and
 * if the LLM dropped 95% of the input, the user had no way to tell
 * whether transcription was bad or summarization was aggressive.
 *
 * The thinking pulse ("the topology agent is processing your last
 * sentence") fires for ~7s after each committed chunk and clears on
 * the next graph update.
 *
 * Lives only when the mic is active OR there is recent content; on a
 * cold session it stays out of the way of the EmptyState hero.
 */
export function TranscriptStream() {
  const reduce = useReducedMotion();
  const history = useTranscriptHistory();
  const partials = useTranscriptPartials();
  const thinking = useThinking();
  const micActive = useSessionStore((s) => s.micActive);
  const speakerColors = useGraphStore((s) => s.speakerColors);
  const [collapsed, setCollapsed] = useState(false);

  // Auto-clear thinking the moment a node lands.
  useEffect(() => {
    return useGraphStore.subscribe((state, prev) => {
      if (Object.keys(state.nodes).length > Object.keys(prev.nodes).length) {
        useTranscriptStore.getState().noteAgentSettled();
      }
    });
  }, []);

  const visible = micActive || history.length > 0 || partials.length > 0;
  if (!visible) return null;

  const colorOf = (sid: string) => speakerColors[sid] || "var(--text-tertiary)";
  const speakerLabel = (sid: string) => sid.replace(/^speaker_?/i, "Speaker ");

  return (
    <aside
      className={`ts ${collapsed ? "is-collapsed" : ""}`}
      role="region"
      aria-label="Live transcript"
    >
      <button
        className="ts__handle"
        onClick={() => setCollapsed((c) => !c)}
        aria-label={collapsed ? "Expand transcript" : "Collapse transcript"}
      >
        <span className={`ts__handle-led ${micActive ? "is-live" : ""}`} aria-hidden />
        <span className="ts__handle-text">
          {micActive ? "LISTENING" : "TRANSCRIPT"}
        </span>
        {thinking ? (
          <motion.span
            className="ts__handle-thinking"
            animate={reduce ? undefined : { opacity: [0.3, 1, 0.3] }}
            transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
          >
            • agent is thinking
          </motion.span>
        ) : null}
      </button>

      {!collapsed ? (
        <div className="ts__feed">
          <AnimatePresence initial={false}>
            {history.map((line) => (
              <motion.div
                key={line.id}
                className="ts__line"
                style={{ ["--line-speaker" as string]: colorOf(line.speaker_id) }}
                initial={reduce ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={
                  reduce ? { duration: 0 } : { type: "spring", stiffness: 220, damping: 24 }
                }
              >
                <span className="ts__who">{speakerLabel(line.speaker_id)}</span>
                <span className="ts__text">{line.text}</span>
              </motion.div>
            ))}

            {partials.map((line) => (
              <motion.div
                key={line.id}
                className="ts__line ts__line--partial"
                style={{ ["--line-speaker" as string]: colorOf(line.speaker_id) }}
                initial={reduce ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={
                  reduce ? { duration: 0 } : { type: "spring", stiffness: 260, damping: 26 }
                }
              >
                <span className="ts__who">{speakerLabel(line.speaker_id)}</span>
                <span className="ts__text">
                  {line.text}
                  <motion.span
                    className="ts__caret"
                    aria-hidden
                    animate={reduce ? undefined : { opacity: [0, 1, 0] }}
                    transition={{ duration: 1, repeat: Infinity }}
                  >
                    │
                  </motion.span>
                </span>
              </motion.div>
            ))}

            {history.length === 0 && partials.length === 0 ? (
              <div className="ts__empty">
                <span className="ts__empty-dot" aria-hidden />
                Listening — say anything.
              </div>
            ) : null}
          </AnimatePresence>
        </div>
      ) : null}

      <style>{`
        .ts {
          position: absolute;
          left: 50%;
          bottom: 96px;
          transform: translateX(-50%);
          width: min(720px, calc(100vw - 56px));
          z-index: 25;
          background: rgba(12, 18, 25, 0.78);
          backdrop-filter: blur(14px) saturate(160%);
          -webkit-backdrop-filter: blur(14px) saturate(160%);
          border: 1px solid var(--border-subtle);
          border-radius: 12px;
          box-shadow: var(--shadow-md);
          padding: 6px 8px 10px 8px;
          display: flex;
          flex-direction: column;
          gap: 4px;
          pointer-events: auto;
        }
        .ts.is-collapsed { padding-bottom: 6px; }

        .ts__handle {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 4px 8px;
          border-radius: 999px;
          align-self: flex-start;
          font-family: var(--font-display);
          font-size: 10px;
          letter-spacing: 0.18em;
          font-weight: 600;
          color: var(--text-tertiary);
        }
        .ts__handle:hover { background: var(--bg-overlay); color: var(--text-secondary); }
        .ts__handle-led {
          width: 6px; height: 6px;
          border-radius: 999px;
          background: var(--text-tertiary);
        }
        .ts__handle-led.is-live {
          background: var(--signature-accent);
          box-shadow: 0 0 8px var(--signature-accent-glow);
        }
        .ts__handle-thinking {
          color: var(--signature-accent);
          letter-spacing: 0.04em;
          text-transform: none;
          font-family: var(--font-body);
          font-size: 11px;
          font-weight: 500;
        }

        .ts__feed {
          display: flex;
          flex-direction: column;
          gap: 6px;
          max-height: 200px;
          overflow-y: auto;
          padding: 4px 4px 2px 4px;
          scrollbar-width: thin;
        }
        .ts__line {
          display: grid;
          grid-template-columns: 96px 1fr;
          gap: 12px;
          align-items: baseline;
          padding: 6px 8px;
          border-radius: 6px;
          border-left: 2px solid var(--line-speaker);
          background: color-mix(in srgb, var(--line-speaker) 5%, transparent);
        }
        .ts__line--partial {
          background: color-mix(in srgb, var(--line-speaker) 8%, transparent);
        }
        .ts__line--partial .ts__text {
          color: var(--text-secondary);
          font-style: italic;
        }
        .ts__who {
          font-family: var(--font-mono);
          font-size: 10px;
          letter-spacing: 0.06em;
          color: var(--line-speaker);
          text-transform: uppercase;
          font-weight: 600;
        }
        .ts__text {
          font-family: var(--font-body);
          font-size: 13px;
          line-height: 1.4;
          color: var(--text-primary);
        }
        .ts__caret {
          color: var(--signature-accent);
          margin-left: 2px;
        }
        .ts__empty {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 10px 8px;
          font-family: var(--font-body);
          font-size: 12px;
          color: var(--text-tertiary);
          font-style: italic;
        }
        .ts__empty-dot {
          width: 6px; height: 6px;
          border-radius: 999px;
          background: var(--signature-accent);
          box-shadow: 0 0 8px var(--signature-accent-glow);
        }
      `}</style>
    </aside>
  );
}

export default TranscriptStream;
