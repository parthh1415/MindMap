import { motion, useReducedMotion } from "framer-motion";
import { Mic } from "lucide-react";

/**
 * Shown when a session has zero nodes.
 *
 * Subtle ambient animation:
 *   - Slow gradient breathing on the headline plate
 *   - 12 small drifting particles
 *   - Microphone glyph with a faint pulsing glow
 *
 * Tone: "Start talking" — declarative, not cute. NO emoji.
 */
export function EmptyState() {
  const reduceMotion = useReducedMotion();

  const particles = Array.from({ length: 12 }, (_, i) => i);

  return (
    <div className="empty-shell" role="status" aria-label="No nodes yet">
      {/* drifting particles */}
      <div className="empty-particles" aria-hidden>
        {particles.map((i) => (
          <motion.span
            key={i}
            className="empty-particle"
            style={{
              left: `${(i * 7919) % 100}%`,
              top: `${(i * 6113) % 100}%`,
              background:
                i % 6 === 0
                  ? "var(--speaker-1)"
                  : i % 6 === 1
                    ? "var(--speaker-2)"
                    : i % 6 === 2
                      ? "var(--speaker-3)"
                      : i % 6 === 3
                        ? "var(--speaker-4)"
                        : i % 6 === 4
                          ? "var(--speaker-5)"
                          : "var(--speaker-6)",
            }}
            animate={
              reduceMotion
                ? undefined
                : {
                    y: [0, -20, 0],
                    x: [0, (i % 2 === 0 ? 8 : -8), 0],
                    opacity: [0.18, 0.5, 0.18],
                  }
            }
            transition={{
              duration: 6 + (i % 4),
              repeat: Infinity,
              ease: "easeInOut",
              delay: (i * 0.4) % 3,
            }}
          />
        ))}
      </div>

      <motion.div
        className="empty-card"
        animate={
          reduceMotion
            ? undefined
            : {
                boxShadow: [
                  "0 0 32px rgba(34, 211, 238, 0.10)",
                  "0 0 48px rgba(34, 211, 238, 0.18)",
                  "0 0 32px rgba(34, 211, 238, 0.10)",
                ],
              }
        }
        transition={{ duration: 5, repeat: Infinity, ease: "easeInOut" }}
      >
        <motion.div
          className="empty-icon"
          animate={reduceMotion ? undefined : { scale: [1, 1.06, 1] }}
          transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
        >
          <Mic size={20} />
        </motion.div>
        <h2 className="empty-title">Start talking</h2>
        <p className="empty-sub">
          Speak naturally. Concepts will surface as ghosts and commit when the
          conversation confirms them.
        </p>
      </motion.div>

      <style>{`
        .empty-shell {
          position: absolute;
          inset: 0;
          display: grid;
          place-items: center;
          z-index: 2;
          pointer-events: none;
        }
        .empty-particles {
          position: absolute;
          inset: 0;
          pointer-events: none;
        }
        .empty-particle {
          position: absolute;
          width: 4px;
          height: 4px;
          border-radius: 999px;
          opacity: 0.3;
          filter: blur(1px);
        }
        .empty-card {
          position: relative;
          padding: var(--space-10) var(--space-12);
          border-radius: var(--radius-xl);
          background: linear-gradient(180deg, rgba(15, 23, 42, 0.65), rgba(15, 23, 42, 0.4));
          border: 1px solid var(--border-subtle);
          backdrop-filter: blur(10px);
          text-align: center;
          max-width: 420px;
        }
        .empty-icon {
          display: inline-grid;
          place-items: center;
          width: 44px;
          height: 44px;
          border-radius: 999px;
          background: rgba(34, 211, 238, 0.12);
          color: var(--signature-accent);
          margin-bottom: var(--space-4);
          box-shadow: 0 0 24px var(--signature-accent-glow);
        }
        .empty-title {
          font-family: var(--font-display);
          font-size: var(--font-size-2xl);
          font-weight: 600;
          color: var(--text-primary);
          margin-bottom: var(--space-2);
          letter-spacing: -0.01em;
        }
        .empty-sub {
          font-size: var(--font-size-sm);
          color: var(--text-secondary);
          line-height: var(--line-height-relaxed);
          max-width: 340px;
          margin: 0 auto;
        }
      `}</style>
    </div>
  );
}

export default EmptyState;
