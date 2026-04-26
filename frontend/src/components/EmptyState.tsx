import { motion, useReducedMotion } from "framer-motion";

/**
 * First-run hero, shown when the live graph has zero nodes and zero
 * ghosts. Communicates "speak and the map appears" with the quiet
 * authority of a developer-tool surface — Phosphor Dark canvas, volt
 * accent, Space Grotesk display, no emoji, no AI-template language.
 *
 * Composition (top to bottom, centered, ~600px max-width):
 *   - tiny wordmark with a phosphor-dot logomark
 *   - the headline
 *   - a single subhead
 *   - a three-line "what to expect" list with accent-tinted bullets
 *   - a soft pulsing waveform indicator (5 bars, staggered springs)
 *   - keyboard hint chip
 * Behind: a slow drift of dim accent-tinted dots.
 */
export function EmptyState() {
  const reduce = useReducedMotion();

  // 18 deterministic particles — coordinates from a small LCG so layout
  // doesn't shift between renders.
  const particles = Array.from({ length: 18 }, (_, i) => {
    const a = (i * 9301 + 49297) % 233280;
    const b = (i * 21034 + 7813) % 233280;
    return {
      i,
      left: (a / 233280) * 100,
      top: (b / 233280) * 100,
      delay: (i * 0.41) % 4,
      duration: 9 + (i % 5),
      size: 2 + (i % 3),
    };
  });

  const bars = [0, 1, 2, 3, 4];

  return (
    <div className="es-shell" role="status" aria-label="Waiting for speech">
      <div className="es-particles" aria-hidden>
        {particles.map((p) => (
          <motion.span
            key={p.i}
            className="es-particle"
            style={{
              left: `${p.left}%`,
              top: `${p.top}%`,
              width: `${p.size}px`,
              height: `${p.size}px`,
            }}
            animate={
              reduce
                ? undefined
                : {
                    y: [0, -22, 0],
                    opacity: [0.0, 0.55, 0.0],
                  }
            }
            transition={{
              duration: p.duration,
              repeat: Infinity,
              ease: "easeInOut",
              delay: p.delay,
            }}
          />
        ))}
      </div>

      <motion.div
        className="es-stack"
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 180, damping: 24, delay: 0.05 }}
      >
        <div className="es-mark">
          <span className="es-dot" aria-hidden />
          <span className="es-wordmark">MINDMAP</span>
        </div>

        <h1 className="es-headline">
          <span className="es-headline-text">Speak. The map appears.</span>
          {!reduce ? <span className="es-sweep" aria-hidden /> : null}
        </h1>

        <p className="es-sub">
          A live mind-map builds itself from your conversation. There is no
          end-of-session summary — the map is the summary.
        </p>

        <ul className="es-list" role="list">
          <li><span className="es-bullet" aria-hidden /> Ghost nodes drift in as you talk.</li>
          <li><span className="es-bullet" aria-hidden /> The graph reorganizes around recurring topics.</li>
          <li><span className="es-bullet" aria-hidden /> Scrub the timeline to revisit any moment.</li>
        </ul>

        <div className="es-meter" aria-hidden>
          {bars.map((i) => (
            <motion.span
              key={i}
              className="es-bar"
              animate={
                reduce
                  ? { scaleY: 0.4 }
                  : { scaleY: [0.25, 1, 0.4, 0.8, 0.25] }
              }
              transition={{
                duration: 1.6,
                repeat: Infinity,
                ease: "easeInOut",
                delay: i * 0.12,
              }}
            />
          ))}
        </div>

        <div className="es-hint">
          <kbd>Click</kbd>
          <span>the mic in the top bar to begin</span>
        </div>
      </motion.div>

      <style>{`
        .es-shell {
          position: absolute;
          inset: 0;
          display: grid;
          place-items: center;
          z-index: 2;
          pointer-events: none;
        }
        .es-particles {
          position: absolute;
          inset: 0;
          pointer-events: none;
          overflow: hidden;
        }
        .es-particle {
          position: absolute;
          border-radius: 999px;
          background: var(--signature-accent);
          opacity: 0;
          filter: blur(0.5px);
        }
        .es-stack {
          position: relative;
          z-index: 3;
          width: min(560px, calc(100vw - 64px));
          padding: var(--sp-8) var(--sp-6);
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: var(--sp-5);
          pointer-events: auto;
        }
        .es-mark {
          display: inline-flex;
          align-items: center;
          gap: var(--sp-2);
          padding: 0;
        }
        .es-dot {
          width: 8px;
          height: 8px;
          border-radius: 999px;
          background: var(--signature-accent);
          box-shadow: 0 0 12px var(--signature-accent-glow);
          display: inline-block;
        }
        .es-wordmark {
          font-family: var(--font-display);
          font-size: var(--fs-xs);
          font-weight: 600;
          letter-spacing: 0.18em;
          color: var(--text-tertiary);
        }
        .es-headline {
          position: relative;
          display: inline-block;
          font-family: var(--font-display);
          font-size: var(--fs-display-2);
          font-weight: 600;
          color: var(--text-primary);
          letter-spacing: var(--tracking-display);
          line-height: var(--lh-display);
          margin: 0;
          isolation: isolate;
        }
        .es-headline-text { position: relative; z-index: 1; }
        .es-sweep {
          position: absolute;
          inset: 0;
          background: linear-gradient(
            90deg,
            transparent 0%,
            color-mix(in srgb, var(--signature-accent) 22%, transparent) 48%,
            color-mix(in srgb, var(--signature-accent) 35%, transparent) 50%,
            color-mix(in srgb, var(--signature-accent) 22%, transparent) 52%,
            transparent 100%
          );
          mix-blend-mode: screen;
          background-size: 280% 100%;
          background-position: 200% 0;
          animation: es-sweep 7s ease-in-out infinite;
          pointer-events: none;
          z-index: 2;
        }
        @keyframes es-sweep {
          0%   { background-position: -200% 0; opacity: 0; }
          25%  { opacity: 1; }
          75%  { opacity: 1; }
          100% { background-position: 200% 0;  opacity: 0; }
        }
        .es-sub {
          font-family: var(--font-body);
          font-size: var(--fs-md);
          color: var(--text-secondary);
          line-height: 1.5;
          max-width: 48ch;
        }
        .es-list {
          list-style: none;
          padding: 0;
          margin: var(--sp-2) 0 0 0;
          display: flex;
          flex-direction: column;
          gap: var(--sp-2);
          font-family: var(--font-body);
          font-size: var(--fs-sm);
          color: var(--text-tertiary);
          line-height: 1.6;
        }
        .es-list li {
          display: flex;
          align-items: center;
          gap: var(--sp-3);
        }
        .es-bullet {
          width: 6px;
          height: 6px;
          border-radius: 999px;
          background: var(--signature-accent);
          box-shadow: 0 0 8px var(--signature-accent-soft);
          flex-shrink: 0;
        }
        .es-meter {
          margin-top: var(--sp-3);
          display: flex;
          align-items: end;
          gap: 4px;
          height: 22px;
        }
        .es-bar {
          width: 3px;
          height: 100%;
          background: var(--signature-accent);
          border-radius: 2px;
          transform-origin: bottom;
          opacity: 0.85;
        }
        .es-hint {
          display: inline-flex;
          align-items: center;
          gap: var(--sp-2);
          font-family: var(--font-body);
          font-size: var(--fs-xs);
          color: var(--text-tertiary);
          margin-top: var(--sp-2);
        }
        .es-hint kbd {
          font-family: var(--font-mono);
          font-size: 10px;
          padding: 3px 7px;
          background: var(--bg-overlay);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-sm);
          color: var(--text-secondary);
          letter-spacing: 0.04em;
        }
      `}</style>
    </div>
  );
}

export default EmptyState;
