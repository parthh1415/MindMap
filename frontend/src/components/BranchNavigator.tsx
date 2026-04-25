import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useMemo, useState } from "react";
import { GitBranch, Plus, Trash2, X, Eye, GitCompareArrows } from "lucide-react";
import dayjs from "dayjs";
import { springEntrance, springLayout } from "@/lib/motion";
import {
  useBranchStore,
  type BranchSummary,
} from "@/state/branchStore";
import { useSessionStore } from "@/state/sessionStore";
import { useGraphStore } from "@/state/graphStore";

function backendUrl(): string {
  const base =
    (import.meta.env?.VITE_BACKEND_URL as string | undefined) ??
    "http://localhost:8000";
  return base.replace(/\/$/, "");
}

interface BranchListBody {
  branches: BranchSummary[];
}

/**
 * Tiny SVG dot-cluster thumbnail. Up to 8 dots positioned by hash so the
 * pattern is stable per branch id. The active branch uses the volt accent;
 * others use neutral text-tertiary.
 */
function BranchThumbnail({
  id,
  active,
}: {
  id: string;
  active: boolean;
}) {
  const dots = useMemo(() => {
    const out: Array<{ x: number; y: number; r: number }> = [];
    let h = 0;
    for (let i = 0; i < id.length; i++) {
      h = ((h << 5) - h + id.charCodeAt(i)) | 0;
    }
    const N = 8;
    for (let i = 0; i < N; i++) {
      // Mix the hash for each dot.
      h = (h * 1103515245 + 12345) & 0x7fffffff;
      const x = 6 + (h % 36);
      h = (h * 1103515245 + 12345) & 0x7fffffff;
      const y = 6 + (h % 28);
      h = (h * 1103515245 + 12345) & 0x7fffffff;
      const r = 1.4 + (h % 14) / 12;
      out.push({ x, y, r });
    }
    return out;
  }, [id]);

  const fill = active ? "var(--signature-accent)" : "var(--text-tertiary)";
  return (
    <svg viewBox="0 0 48 40" className="branch-card__thumb" aria-hidden>
      {dots.map((d, i) => (
        <circle key={i} cx={d.x} cy={d.y} r={d.r} fill={fill} opacity={active ? 0.9 : 0.55} />
      ))}
    </svg>
  );
}

/**
 * BranchNavigator — replaces SidePanel as the right-side surface.
 *
 * Slides in from the right (AnimatePresence + spring). Lists each branch
 * as a card with a tiny thumbnail, editable name, "Open", "Compare with
 * current", and "Delete". Active branch gets a left-edge stripe.
 */
export function BranchNavigator() {
  const open = useSessionStore((s) => s.sidePanelOpen);
  const setOpen = useSessionStore((s) => s.setSidePanelOpen);
  const sessionId = useSessionStore((s) => s.currentSessionId);
  const setSession = useSessionStore((s) => s.setSession);
  const timelineMode = useGraphStore((s) => s.timelineMode);

  const branches = useBranchStore((s) => s.branches);
  const setBranches = useBranchStore((s) => s.setBranches);
  const removeBranch = useBranchStore((s) => s.removeBranch);
  const openCompare = useBranchStore((s) => s.openCompare);
  const pivotSuggestions = useBranchStore((s) => s.pivotSuggestions);
  const reduce = useReducedMotion();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  // Fetch branches when the panel opens AND we have a session.
  useEffect(() => {
    if (!open || !sessionId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${backendUrl()}/sessions/${sessionId}/branches`);
        if (!res.ok) throw new Error(`status ${res.status}`);
        const body = (await res.json()) as BranchListBody;
        if (cancelled) return;
        setBranches(body.branches ?? []);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[BranchNavigator] fetch failed", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, sessionId, setBranches]);

  const onOpenBranch = (b: BranchSummary) => {
    setSession(b._id, b.name);
    // close panel so the user sees the freshly loaded graph
    setOpen(false);
  };

  const onCompare = (b: BranchSummary) => {
    openCompare(b._id);
  };

  const onDelete = async (b: BranchSummary) => {
    // Best-effort DELETE; backend may not implement it yet — fall back to
    // a local-only removal so the UI stays responsive.
    try {
      const res = await fetch(`${backendUrl()}/sessions/${b._id}`, {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 404 && res.status !== 405) {
        throw new Error(`status ${res.status}`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[BranchNavigator] delete fallback (local-only)", err);
    }
    removeBranch(b._id);
  };

  const startRename = (b: BranchSummary) => {
    setEditingId(b._id);
    setEditValue(b.name);
  };
  const commitRename = () => {
    setEditingId(null);
    // We persist the rename optimistically in local state; the spec says
    // rename support is best-effort.
    if (editingId == null) return;
    const idx = branches.findIndex((b) => b._id === editingId);
    if (idx === -1) return;
    const next = branches.slice();
    next[idx] = { ...next[idx], name: editValue.trim() || next[idx].name };
    setBranches(next);
  };

  const canCreateBranch =
    pivotSuggestions.length > 0 || (timelineMode.active === true);

  return (
    <AnimatePresence>
      {open ? (
        <motion.aside
          key="branch-nav"
          className="branch-nav"
          initial={reduce ? { opacity: 0 } : { x: "100%", opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={reduce ? { opacity: 0 } : { x: "100%", opacity: 0 }}
          transition={reduce ? { duration: 0 } : springEntrance}
          aria-label="Branch navigator"
        >
          <header className="branch-nav__head">
            <div className="branch-nav__title">
              <GitBranch size={14} />
              <span>BRANCHES</span>
              <span className="branch-nav__count tabular">
                {branches.length}
              </span>
            </div>
            <div className="branch-nav__head-actions">
              <button
                type="button"
                className="branch-nav__new"
                disabled={!canCreateBranch}
                title={
                  canCreateBranch
                    ? "Create a branch from the latest pivot suggestion or scrubber position"
                    : "Branch when a pivot is suggested or you scrub into the past"
                }
                aria-label="Create a new branch"
                onClick={() => {
                  // The PivotToast and BranchButton already handle the actual
                  // POST. This button just signals intent — focus the toast.
                  // For now it is a visual affordance.
                }}
              >
                <Plus size={12} />
                <span>New</span>
              </button>
              <button
                type="button"
                className="branch-nav__close"
                onClick={() => setOpen(false)}
                aria-label="Close branch navigator"
              >
                <X size={14} />
              </button>
            </div>
          </header>

          <ul className="branch-nav__list">
            {branches.length === 0 ? (
              <li className="branch-nav__empty">
                <span>No branches yet.</span>
                <span className="branch-nav__empty-hint">
                  Branch at a pivot moment or from a past timeline position.
                </span>
              </li>
            ) : (
              branches.map((b) => {
                const active = b._id === sessionId;
                const ts = b.branched_from?.timestamp;
                return (
                  <motion.li
                    key={b._id}
                    layout
                    transition={reduce ? { duration: 0 } : springLayout}
                    className={`branch-card ${active ? "is-active" : ""}`}
                  >
                    {active ? (
                      <span className="branch-card__stripe" aria-hidden />
                    ) : null}
                    <BranchThumbnail id={b._id} active={active} />
                    <div className="branch-card__body">
                      <div className="branch-card__title-row">
                        {editingId === b._id ? (
                          <input
                            className="branch-card__name-input"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={commitRename}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") commitRename();
                              if (e.key === "Escape") setEditingId(null);
                            }}
                            autoFocus
                          />
                        ) : (
                          <button
                            type="button"
                            className="branch-card__name"
                            onClick={() => startRename(b)}
                            aria-label={`Rename ${b.name}`}
                          >
                            {b.name}
                          </button>
                        )}
                      </div>
                      <div className="branch-card__meta tabular">
                        <span>{b.node_count} nodes</span>
                        {ts ? (
                          <span>· branched at {dayjs(ts).format("HH:mm:ss")}</span>
                        ) : null}
                      </div>
                      <div className="branch-card__actions">
                        <button
                          type="button"
                          className="branch-card__action"
                          onClick={() => onOpenBranch(b)}
                          aria-label={`Open branch ${b.name}`}
                        >
                          <Eye size={11} />
                          <span>Open</span>
                        </button>
                        <button
                          type="button"
                          className="branch-card__action"
                          onClick={() => onCompare(b)}
                          aria-label={`Compare with ${b.name}`}
                          disabled={active}
                        >
                          <GitCompareArrows size={11} />
                          <span>Compare</span>
                        </button>
                        <button
                          type="button"
                          className="branch-card__action branch-card__action--danger"
                          onClick={() => onDelete(b)}
                          aria-label={`Delete branch ${b.name}`}
                          disabled={active}
                        >
                          <Trash2 size={11} />
                          <span>Delete</span>
                        </button>
                      </div>
                    </div>
                  </motion.li>
                );
              })
            )}
          </ul>

          <style>{`
            .branch-nav {
              position: fixed;
              top: 0; right: 0; bottom: 0;
              width: min(380px, 92vw);
              z-index: var(--z-side);
              background: var(--bg-surface);
              border-left: 1px solid var(--border-subtle);
              box-shadow: var(--elev-3);
              display: flex;
              flex-direction: column;
            }
            .branch-nav__head {
              display: flex;
              align-items: center;
              justify-content: space-between;
              padding: var(--space-4) var(--space-5);
              border-bottom: 1px solid var(--border-subtle);
            }
            .branch-nav__title {
              display: inline-flex;
              gap: var(--space-2);
              align-items: center;
              font-family: var(--font-display);
              font-size: var(--fs-xs);
              letter-spacing: 0.18em;
              color: var(--text-tertiary);
            }
            .branch-nav__count {
              padding: 2px 6px;
              border-radius: 999px;
              background: var(--bg-overlay);
              color: var(--text-secondary);
              font-family: var(--font-mono);
              font-size: 10px;
            }
            .branch-nav__head-actions { display: inline-flex; gap: var(--space-2); }
            .branch-nav__new {
              display: inline-flex;
              align-items: center;
              gap: var(--space-1);
              padding: var(--space-1) var(--space-3);
              border-radius: var(--radius-pill);
              background: var(--signature-accent-soft);
              color: var(--signature-accent);
              font-family: var(--font-display);
              font-size: var(--fs-xs);
              letter-spacing: 0.08em;
              font-weight: 600;
              border: 1px solid transparent;
            }
            .branch-nav__new:disabled {
              opacity: 0.4;
              color: var(--text-tertiary);
              background: transparent;
              border-color: var(--border-subtle);
              cursor: not-allowed;
            }
            .branch-nav__close {
              width: 28px; height: 28px;
              border-radius: var(--radius-sm);
              display: grid; place-items: center;
              color: var(--text-secondary);
            }
            .branch-nav__close:hover {
              background: var(--bg-overlay);
              color: var(--text-primary);
            }
            .branch-nav__list {
              list-style: none;
              padding: var(--space-3);
              margin: 0;
              flex: 1;
              overflow-y: auto;
              display: flex;
              flex-direction: column;
              gap: var(--space-2);
            }
            .branch-nav__empty {
              padding: var(--space-8) var(--space-4);
              text-align: center;
              color: var(--text-tertiary);
              font-size: var(--fs-sm);
              display: flex;
              flex-direction: column;
              gap: var(--space-2);
            }
            .branch-nav__empty-hint {
              font-size: var(--fs-xs);
              color: var(--text-disabled);
            }
            .branch-card {
              position: relative;
              display: grid;
              grid-template-columns: 56px 1fr;
              gap: var(--space-3);
              padding: var(--space-3);
              border-radius: var(--radius-lg);
              border: 1px solid var(--border-subtle);
              background: var(--bg-raised);
              overflow: hidden;
            }
            .branch-card.is-active {
              border-color: var(--signature-accent-soft);
              box-shadow: 0 0 0 1px var(--signature-accent-soft) inset;
            }
            .branch-card__stripe {
              position: absolute;
              left: 0; top: 0; bottom: 0;
              width: 3px;
              background: var(--signature-accent);
              box-shadow: 0 0 12px var(--signature-accent-glow);
            }
            .branch-card__thumb {
              width: 48px; height: 40px;
              align-self: center;
              border-radius: var(--radius-sm);
              background: var(--bg-base);
              border: 1px solid var(--border-subtle);
            }
            .branch-card__body { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
            .branch-card__title-row { display: flex; align-items: center; gap: var(--space-2); }
            .branch-card__name {
              font-weight: 600;
              color: var(--text-primary);
              text-align: left;
              padding: 0;
              background: transparent;
              border: none;
              font-size: var(--fs-md);
              cursor: text;
              white-space: nowrap;
              overflow: hidden;
              text-overflow: ellipsis;
            }
            .branch-card__name-input {
              font-weight: 600;
              color: var(--text-primary);
              font-size: var(--fs-md);
              background: var(--bg-base);
              border: 1px solid var(--signature-accent-soft);
              border-radius: var(--radius-sm);
              padding: 2px 6px;
              outline: none;
              font-family: var(--font-body);
            }
            .branch-card__meta {
              font-size: var(--fs-xs);
              color: var(--text-tertiary);
              display: flex; gap: var(--space-1);
            }
            .branch-card__actions {
              display: flex;
              gap: var(--space-1);
              padding-top: var(--space-2);
            }
            .branch-card__action {
              display: inline-flex;
              align-items: center;
              gap: 4px;
              padding: 4px 8px;
              border-radius: var(--radius-sm);
              background: transparent;
              border: 1px solid var(--border-subtle);
              color: var(--text-secondary);
              font-family: var(--font-display);
              font-size: 10px;
              letter-spacing: 0.06em;
              font-weight: 500;
            }
            .branch-card__action:hover:not(:disabled) {
              border-color: var(--border-default);
              color: var(--text-primary);
              background: var(--bg-overlay);
            }
            .branch-card__action:disabled {
              opacity: 0.35; cursor: not-allowed;
            }
            .branch-card__action--danger:hover:not(:disabled) {
              color: var(--color-danger);
              border-color: rgba(255, 84, 112, 0.4);
            }
          `}</style>
        </motion.aside>
      ) : null}
    </AnimatePresence>
  );
}

export default BranchNavigator;
