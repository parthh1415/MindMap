import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useMemo, useState } from "react";
import { GitBranch, X } from "lucide-react";
import { springEntrance } from "@/lib/motion";
import {
  useBranchStore,
  pivotIdFor,
  type BranchSummary,
  type PivotPoint,
} from "@/state/branchStore";
import { useSessionStore } from "@/state/sessionStore";

const AUTO_DISMISS_MS = 60_000;

function backendUrl(): string {
  const base =
    (import.meta.env?.VITE_BACKEND_URL as string | undefined) ??
    "http://localhost:8000";
  return base.replace(/\/$/, "");
}

/**
 * PivotToast — a small floating chip in the bottom-right (above the
 * scrubber, NOT covering the speaker legend) that surfaces pivot-here
 * suggestions detected by the pivot agent. Two actions: branch here +
 * dismiss. Auto-dismisses after 60s.
 */
export function PivotToast() {
  const sessionId = useSessionStore((s) => s.currentSessionId);
  const pivots = useBranchStore((s) => s.pivotSuggestions);
  const dismissedIds = useBranchStore((s) => s.dismissedPivotIds);
  const dismissPivot = useBranchStore((s) => s.dismissPivot);
  const upsertBranch = useBranchStore((s) => s.upsertBranch);
  const setBranching = useSessionStore((s) => s.setBranching);
  const pushBranch = useSessionStore((s) => s.pushBranch);
  const reduce = useReducedMotion();

  // Pick the most recent (highest timestamp) non-dismissed pivot.
  const active: PivotPoint | null = useMemo(() => {
    if (!sessionId) return null;
    const visible = pivots
      .filter((p) => !dismissedIds.has(pivotIdFor(sessionId, p)))
      .slice()
      .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
    return visible[0] ?? null;
  }, [pivots, dismissedIds, sessionId]);

  // Auto-dismiss after 60s of being shown.
  const [shownAt, setShownAt] = useState<number | null>(null);
  useEffect(() => {
    if (!active || !sessionId) {
      setShownAt(null);
      return;
    }
    setShownAt(Date.now());
    const id = window.setTimeout(() => {
      dismissPivot(pivotIdFor(sessionId, active));
    }, AUTO_DISMISS_MS);
    return () => window.clearTimeout(id);
  }, [active?.timestamp, active?.pivot_label, sessionId, dismissPivot, active]);
  // shownAt is referenced for the progress styling below.
  void shownAt;

  const onBranch = async () => {
    if (!active || !sessionId) return;
    setBranching({
      phase: "splitting",
      from_session_id: sessionId,
      at_timestamp: active.timestamp,
    });
    try {
      const res = await fetch(`${backendUrl()}/sessions/${sessionId}/branch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ timestamp: active.timestamp }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const json = (await res.json()) as { _id: string; name: string };
      const newBranch: BranchSummary = {
        _id: json._id,
        name: json.name,
        branched_from: { session_id: sessionId, timestamp: active.timestamp },
        node_count: 0,
      };
      upsertBranch(newBranch);
      pushBranch({
        session_id: json._id,
        name: json.name,
        branched_at: active.timestamp,
        parent_session_id: sessionId,
      });
      window.setTimeout(() => {
        setBranching({ phase: "complete", new_session_id: json._id });
        window.setTimeout(() => setBranching({ phase: "idle" }), 400);
      }, 700);
      // Always dismiss after a successful branch so the chip clears.
      dismissPivot(pivotIdFor(sessionId, active));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[PivotToast] branch failed", err);
      setBranching({ phase: "idle" });
    }
  };

  const onDismiss = () => {
    if (!active || !sessionId) return;
    dismissPivot(pivotIdFor(sessionId, active));
  };

  return (
    <AnimatePresence>
      {active && sessionId ? (
        <motion.aside
          key={`${active.timestamp}-${active.pivot_label}`}
          className="pivot-toast"
          role="status"
          aria-live="polite"
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.97 }}
          transition={reduce ? { duration: 0 } : springEntrance}
        >
          <div className="pivot-toast__rail" aria-hidden />
          <div className="pivot-toast__head">
            <span className="pivot-toast__icon" aria-hidden>
              <GitBranch size={12} />
            </span>
            <span className="pivot-toast__label">{active.pivot_label}</span>
            <button
              type="button"
              className="pivot-toast__close"
              onClick={onDismiss}
              aria-label="Dismiss pivot suggestion"
            >
              <X size={12} />
            </button>
          </div>
          <p className="pivot-toast__why">{active.why}</p>
          <div className="pivot-toast__actions">
            <button
              type="button"
              className="pivot-toast__cta"
              onClick={onBranch}
            >
              Branch here
            </button>
            <button
              type="button"
              className="pivot-toast__ghost"
              onClick={onDismiss}
            >
              Dismiss
            </button>
          </div>

          <style>{`
            .pivot-toast {
              position: fixed;
              right: 20px;
              bottom: 132px;
              width: 280px;
              z-index: var(--z-legend);
              background: rgba(12, 18, 25, 0.85);
              backdrop-filter: blur(14px) saturate(160%);
              -webkit-backdrop-filter: blur(14px) saturate(160%);
              border: 1px solid var(--border-subtle);
              border-radius: var(--radius-lg);
              padding: var(--space-3) var(--space-4) var(--space-3) var(--space-5);
              box-shadow: var(--shadow-lg), 0 0 0 1px var(--signature-accent-soft);
              display: flex;
              flex-direction: column;
              gap: var(--space-2);
              overflow: hidden;
            }
            .pivot-toast__rail {
              position: absolute;
              left: 0; top: 0; bottom: 0;
              width: 3px;
              background: var(--signature-accent);
              box-shadow: 0 0 12px var(--signature-accent-glow);
            }
            .pivot-toast__head {
              display: grid;
              grid-template-columns: auto 1fr auto;
              align-items: center;
              gap: var(--space-2);
            }
            .pivot-toast__icon {
              width: 18px; height: 18px;
              border-radius: 999px;
              display: grid; place-items: center;
              background: var(--signature-accent-soft);
              color: var(--signature-accent);
            }
            .pivot-toast__label {
              font-family: var(--font-display);
              font-size: var(--font-size-sm);
              font-weight: 600;
              letter-spacing: 0.02em;
              color: var(--text-primary);
            }
            .pivot-toast__close {
              width: 22px; height: 22px;
              border-radius: var(--radius-sm);
              display: grid; place-items: center;
              color: var(--text-tertiary);
            }
            .pivot-toast__close:hover {
              background: var(--bg-overlay);
              color: var(--text-primary);
            }
            .pivot-toast__why {
              font-size: var(--font-size-xs);
              line-height: var(--line-height-normal);
              color: var(--text-secondary);
              margin: 0;
            }
            .pivot-toast__actions {
              display: flex;
              gap: var(--space-2);
              padding-top: var(--space-1);
            }
            .pivot-toast__cta {
              flex: 1;
              padding: var(--space-2) var(--space-3);
              border-radius: var(--radius-md);
              background: var(--signature-accent);
              color: var(--text-inverse);
              font-family: var(--font-display);
              font-size: var(--font-size-xs);
              font-weight: 600;
              letter-spacing: 0.06em;
            }
            .pivot-toast__cta:hover { background: var(--signature-accent-strong); }
            .pivot-toast__ghost {
              padding: var(--space-2) var(--space-3);
              border-radius: var(--radius-md);
              background: transparent;
              color: var(--text-tertiary);
              font-family: var(--font-display);
              font-size: var(--font-size-xs);
              letter-spacing: 0.06em;
              border: 1px solid var(--border-subtle);
            }
            .pivot-toast__ghost:hover {
              color: var(--text-primary);
              border-color: var(--border-default);
            }
          `}</style>
        </motion.aside>
      ) : null}
    </AnimatePresence>
  );
}

export default PivotToast;
