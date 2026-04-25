import { motion, useReducedMotion } from "framer-motion";
import { useGraphStore } from "@/state/graphStore";

/**
 * Floating chip-rack pinned top-right showing every speaker the system
 * has heard. Each row: a colored disc, the speaker label, and a tiny
 * 3-bar pseudo-waveform that pulses when the row is the currently
 * active speaker.
 */
export function SpeakerLegend() {
  const speakerColors = useGraphStore((s) => s.speakerColors);
  const activeSpeakerId = useGraphStore((s) => s.activeSpeakerId);
  const reduce = useReducedMotion();

  const speakers = Object.entries(speakerColors);
  if (speakers.length === 0) return null;

  return (
    <aside className="legend" aria-label="Speakers">
      <div className="legend__head">
        <span className="legend__head-dot" aria-hidden />
        <span className="legend__head-text">SPEAKERS</span>
        <span className="legend__head-count tabular">{speakers.length}</span>
      </div>
      <div className="legend__rows">
        {speakers.map(([speakerId, color], idx) => {
          const isActive = speakerId === activeSpeakerId;
          const display = speakerId.replace(/^speaker_?/i, "Speaker ");
          return (
            <motion.div
              key={speakerId}
              className={`legend__row ${isActive ? "is-active" : ""}`}
              initial={reduce ? false : { opacity: 0, x: 8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={
                reduce
                  ? { duration: 0 }
                  : { delay: idx * 0.04, type: "spring", stiffness: 240, damping: 22 }
              }
              style={{ ["--row-speaker" as string]: color }}
            >
              <motion.span
                className="legend__disc"
                animate={
                  isActive && !reduce
                    ? { boxShadow: [`0 0 0 0 ${color}80`, `0 0 0 5px ${color}00`] }
                    : {}
                }
                transition={{ duration: 1.4, repeat: Infinity, ease: "easeOut" }}
                aria-hidden
              />
              <span className="legend__name">{display}</span>
              <span className="legend__bars" aria-hidden>
                {[0, 1, 2].map((i) => (
                  <motion.span
                    key={i}
                    animate={
                      isActive && !reduce
                        ? { scaleY: [0.3, 1, 0.5, 0.85, 0.3] }
                        : { scaleY: 0.3 }
                    }
                    transition={{
                      duration: 1.2,
                      repeat: Infinity,
                      ease: "easeInOut",
                      delay: i * 0.1,
                    }}
                  />
                ))}
              </span>
            </motion.div>
          );
        })}
      </div>
      <style>{`
        .legend {
          position: absolute;
          top: 76px;
          right: 20px;
          z-index: var(--z-legend);
          width: 220px;
          background: rgba(12, 18, 25, 0.78);
          backdrop-filter: blur(12px) saturate(160%);
          -webkit-backdrop-filter: blur(12px) saturate(160%);
          border: 1px solid var(--border-subtle);
          border-radius: 12px;
          padding: 12px;
          display: flex;
          flex-direction: column;
          gap: 10px;
          box-shadow: var(--shadow-md);
        }
        .legend__head {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 0 2px 8px 2px;
          border-bottom: 1px solid var(--border-subtle);
        }
        .legend__head-dot {
          width: 6px; height: 6px;
          border-radius: 999px;
          background: var(--signature-accent);
          box-shadow: 0 0 8px var(--signature-accent-glow);
        }
        .legend__head-text {
          font-family: var(--font-display);
          font-size: 10px;
          font-weight: 600;
          letter-spacing: 0.18em;
          color: var(--text-tertiary);
          flex: 1;
        }
        .legend__head-count {
          font-family: var(--font-mono);
          font-size: 10px;
          color: var(--text-tertiary);
          font-variant-numeric: tabular-nums;
        }
        .legend__rows {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .legend__row {
          display: grid;
          grid-template-columns: 14px 1fr auto;
          align-items: center;
          gap: 10px;
          padding: 4px 4px;
          border-radius: 6px;
        }
        .legend__row.is-active {
          background: color-mix(in srgb, var(--row-speaker) 8%, transparent);
        }
        .legend__disc {
          width: 10px; height: 10px;
          border-radius: 999px;
          background: var(--row-speaker);
          justify-self: center;
        }
        .legend__name {
          font-family: var(--font-body);
          font-size: 12px;
          font-weight: 500;
          color: var(--text-primary);
          letter-spacing: -0.005em;
        }
        .legend__bars {
          display: inline-flex;
          align-items: end;
          gap: 2px;
          height: 12px;
        }
        .legend__bars > span {
          display: inline-block;
          width: 2px;
          height: 100%;
          background: var(--row-speaker);
          border-radius: 1px;
          transform-origin: bottom;
          opacity: 0.85;
        }
      `}</style>
    </aside>
  );
}

export default SpeakerLegend;
