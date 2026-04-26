import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ArrowUpRight } from "lucide-react";
import { useEffect } from "react";
import {
  useArtifactStore,
  useArtifactHistory,
  type ArtifactType,
} from "@/state/artifactStore";

const ARTIFACT_LABELS: Record<ArtifactType, string> = {
  prd: "PRD",
  scaffold: "Scaffold",
  decision: "Decision",
  retro: "Retro",
  action: "Action",
  research: "Research",
  debate: "Debate",
  brief: "Brief",
};

/**
 * Top-pinned dropdown listing the past 10 artifacts for the current
 * session. Visible when `historyOpen === true`.
 */
export function ArtifactHistoryBar() {
  const reduce = useReducedMotion();
  const open = useArtifactStore((s) => s.historyOpen);
  const closeHistory = useArtifactStore((s) => s.closeHistory);
  const loadFromHistory = useArtifactStore((s) => s.loadFromHistory);
  const items = useArtifactHistory();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeHistory();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, closeHistory]);

  return (
    <AnimatePresence>
      {open ? (
        <>
          <motion.div
            key="history-backdrop"
            className="art-history__backdrop"
            initial={reduce ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduce ? 0 : 0.16 }}
            onClick={closeHistory}
          />
          <motion.div
            key="art-history-bar"
            className="art-history"
            data-testid="artifact-history"
            role="dialog"
            aria-label="Artifact history"
            initial={reduce ? false : { opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8 }}
            transition={
              reduce
                ? { duration: 0 }
                : { type: "spring", stiffness: 300, damping: 28 }
            }
          >
            <header className="art-history__head">
              <span className="art-history__title">Past artifacts</span>
              <button
                type="button"
                className="art-history__close"
                onClick={closeHistory}
              >
                Close
              </button>
            </header>
            {items.length === 0 ? (
              <p className="art-history__empty">
                No artifacts generated for this session yet.
              </p>
            ) : (
              <ul className="art-history__list">
                {items.slice(0, 10).map((item) => (
                  <li key={item._id}>
                    <button
                      type="button"
                      className="art-history__row"
                      onClick={() => void loadFromHistory(item._id)}
                      data-testid={`history-row-${item._id}`}
                    >
                      <span className="art-history__row-title">{item.title}</span>
                      <span className="art-history__row-type">
                        {ARTIFACT_LABELS[item.artifact_type]}
                      </span>
                      <span className="art-history__row-time tabular">
                        {relativeTime(item.generated_at)}
                      </span>
                      <ArrowUpRight size={12} className="art-history__row-arrow" />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <style>{`
              .art-history__backdrop {
                position: fixed;
                inset: 0;
                background: rgba(2,4,7,0.45);
                z-index: calc(var(--z-modal) - 1);
              }
              .art-history {
                position: fixed;
                top: 60px;
                right: var(--sp-4);
                width: min(360px, 92vw);
                max-height: 60vh;
                overflow: auto;
                z-index: var(--z-modal);
                background: var(--bg-raised);
                border: 1px solid var(--border-default);
                border-radius: var(--radius-lg);
                box-shadow: var(--shadow-lg);
                color: var(--text-primary);
                font-feature-settings: "tnum" 1;
              }
              .art-history__head {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: var(--sp-3) var(--sp-4);
                border-bottom: 1px solid var(--border-subtle);
              }
              .art-history__title {
                font-family: var(--font-display);
                font-weight: 700;
                font-size: var(--fs-sm);
                letter-spacing: 0.08em;
                text-transform: uppercase;
                color: var(--text-secondary);
              }
              .art-history__close {
                background: transparent;
                border: none;
                color: var(--text-tertiary);
                cursor: pointer;
                font-size: var(--fs-xs);
              }
              .art-history__close:hover { color: var(--text-primary); }
              .art-history__empty {
                padding: var(--sp-4);
                color: var(--text-tertiary);
                font-size: var(--fs-sm);
                margin: 0;
              }
              .art-history__list {
                list-style: none;
                margin: 0;
                padding: var(--sp-2);
                display: grid;
                gap: 2px;
              }
              .art-history__row {
                display: grid;
                grid-template-columns: 1fr auto auto auto;
                align-items: center;
                gap: var(--sp-2);
                padding: 8px var(--sp-2);
                background: transparent;
                border: 1px solid transparent;
                border-radius: var(--radius-sm);
                color: var(--text-primary);
                cursor: pointer;
                font-family: inherit;
                text-align: left;
                width: 100%;
              }
              .art-history__row:hover {
                background: var(--bg-overlay);
                border-color: var(--border-subtle);
              }
              .art-history__row-title {
                font-family: var(--font-display);
                font-size: var(--fs-sm);
                font-weight: 600;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
              }
              .art-history__row-type {
                font-family: var(--font-mono);
                font-size: var(--fs-xs);
                color: var(--signature-accent);
                padding: 1px 6px;
                background: var(--signature-accent-soft);
                border-radius: 999px;
              }
              .art-history__row-time {
                font-family: var(--font-mono);
                font-size: var(--fs-xs);
                color: var(--text-tertiary);
              }
              .art-history__row-arrow {
                color: var(--text-tertiary);
              }
              .art-history__row:hover .art-history__row-arrow {
                color: var(--signature-accent);
              }
            `}</style>
          </motion.div>
        </>
      ) : null}
    </AnimatePresence>
  );
}

function relativeTime(iso: string): string {
  try {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return "";
    const diffSec = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (diffSec < 60) return `${diffSec}s ago`;
    const diffMin = Math.round(diffSec / 60);
    if (diffMin < 60) return `${diffMin} min ago`;
    const diffHr = Math.round(diffMin / 60);
    if (diffHr < 24) return `${diffHr} hr ago`;
    const diffDay = Math.round(diffHr / 24);
    return `${diffDay}d ago`;
  } catch {
    return "";
  }
}

export default ArtifactHistoryBar;
