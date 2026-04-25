import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { GitBranch, X } from "lucide-react";
import dayjs from "dayjs";
import { springEntrance } from "@/lib/motion";
import { useSessionStore } from "@/state/sessionStore";

/**
 * Right-side slide-in panel listing branched sessions.
 * Click a branch row to swap the canvas to that session.
 */
export function SidePanel() {
  const open = useSessionStore((s) => s.sidePanelOpen);
  const setOpen = useSessionStore((s) => s.setSidePanelOpen);
  const branches = useSessionStore((s) => s.branchedSessions);
  const setSession = useSessionStore((s) => s.setSession);
  const reduceMotion = useReducedMotion();

  return (
    <AnimatePresence>
      {open ? (
        <motion.aside
          key="sidepanel"
          className="sidepanel"
          initial={reduceMotion ? false : { x: "100%", opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={reduceMotion ? { opacity: 0 } : { x: "100%", opacity: 0 }}
          transition={reduceMotion ? { duration: 0 } : springEntrance}
          aria-label="Branched sessions"
        >
          <header className="sidepanel-head">
            <div className="sidepanel-head__title">
              <GitBranch size={14} />
              <span>Branches</span>
            </div>
            <button
              type="button"
              className="sidepanel-close"
              onClick={() => setOpen(false)}
              aria-label="Close branches panel"
            >
              <X size={16} />
            </button>
          </header>

          <ul className="sidepanel-list">
            {branches.length === 0 ? (
              <li className="sidepanel-empty">No branches yet.</li>
            ) : (
              branches.map((b) => (
                <li key={b.session_id}>
                  <button
                    type="button"
                    className="sidepanel-row"
                    onClick={() => setSession(b.session_id, b.name)}
                  >
                    <span className="sidepanel-row__name">{b.name}</span>
                    <span className="sidepanel-row__meta tabular">
                      from {dayjs(b.branched_at).format("HH:mm:ss")}
                    </span>
                  </button>
                </li>
              ))
            )}
          </ul>

          <style>{`
            .sidepanel {
              position: fixed;
              top: 0;
              right: 0;
              bottom: 0;
              width: min(360px, 90vw);
              z-index: var(--z-side);
              background: var(--bg-surface);
              border-left: 1px solid var(--border-subtle);
              box-shadow: var(--elev-3);
              display: flex;
              flex-direction: column;
            }
            .sidepanel-head {
              display: flex;
              align-items: center;
              justify-content: space-between;
              padding: var(--space-4) var(--space-5);
              border-bottom: 1px solid var(--border-subtle);
            }
            .sidepanel-head__title {
              display: inline-flex;
              gap: var(--space-2);
              align-items: center;
              font-family: var(--font-display);
              font-size: var(--font-size-sm);
              letter-spacing: 0.08em;
              text-transform: uppercase;
              color: var(--text-secondary);
            }
            .sidepanel-close {
              width: 28px;
              height: 28px;
              border-radius: var(--radius-sm);
              display: grid;
              place-items: center;
              color: var(--text-secondary);
            }
            .sidepanel-close:hover { background: var(--bg-overlay); color: var(--text-primary); }
            .sidepanel-list {
              flex: 1;
              list-style: none;
              padding: var(--space-3);
              overflow-y: auto;
            }
            .sidepanel-empty {
              padding: var(--space-8);
              text-align: center;
              color: var(--text-tertiary);
              font-size: var(--font-size-sm);
            }
            .sidepanel-row {
              width: 100%;
              text-align: left;
              padding: var(--space-3) var(--space-4);
              border-radius: var(--radius-md);
              display: flex;
              flex-direction: column;
              gap: var(--space-1);
              border: 1px solid transparent;
            }
            .sidepanel-row:hover {
              background: var(--bg-overlay);
              border-color: var(--border-subtle);
            }
            .sidepanel-row__name {
              font-weight: 500;
              color: var(--text-primary);
            }
            .sidepanel-row__meta {
              font-size: var(--font-size-xs);
              color: var(--text-tertiary);
            }
          `}</style>
        </motion.aside>
      ) : null}
    </AnimatePresence>
  );
}

export default SidePanel;
