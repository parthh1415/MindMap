import { motion, useReducedMotion } from "framer-motion";
import { useGraphStore } from "@/state/graphStore";

/**
 * Floating top-right speaker legend.
 * Each speaker = color disc + label + (when active) glow ring.
 */
export function SpeakerLegend() {
  const speakerColors = useGraphStore((s) => s.speakerColors);
  const activeSpeakerId = useGraphStore((s) => s.activeSpeakerId);
  const reduceMotion = useReducedMotion();

  const speakers = Object.entries(speakerColors);
  if (speakers.length === 0) return null;

  return (
    <aside className="legend" aria-label="Speakers">
      {speakers.map(([speakerId, color], idx) => {
        const isActive = speakerId === activeSpeakerId;
        return (
          <motion.div
            key={speakerId}
            className="legend-row"
            initial={reduceMotion ? false : { opacity: 0, x: 10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={reduceMotion ? { duration: 0 } : { delay: idx * 0.03, type: "spring", stiffness: 240, damping: 22 }}
          >
            <motion.span
              className="legend-disc"
              style={{ background: color }}
              animate={
                isActive && !reduceMotion
                  ? { boxShadow: [`0 0 0 0 ${color}80`, `0 0 0 6px ${color}10`, `0 0 0 0 ${color}80`] }
                  : {}
              }
              transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
              aria-hidden
            />
            <span className="legend-name">
              Speaker {speakerId.length > 8 ? speakerId.slice(0, 6) + "…" : speakerId}
            </span>
          </motion.div>
        );
      })}
      <style>{`
        .legend {
          position: absolute;
          top: var(--space-16);
          right: var(--space-5);
          z-index: var(--z-side);
          background: rgba(15, 23, 42, 0.7);
          backdrop-filter: blur(8px);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-md);
          padding: var(--space-3);
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
          min-width: 160px;
        }
        .legend-row {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          font-size: var(--font-size-xs);
          color: var(--text-secondary);
        }
        .legend-disc {
          width: 10px;
          height: 10px;
          border-radius: 999px;
          flex-shrink: 0;
        }
        .legend-name {
          font-family: var(--font-mono);
          letter-spacing: 0.04em;
        }
      `}</style>
    </aside>
  );
}

export default SpeakerLegend;
