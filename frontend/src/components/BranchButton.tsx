import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { GitBranch } from "lucide-react";
import { springBranch } from "@/lib/motion";
import { useGraphStore } from "@/state/graphStore";
import { useSessionStore } from "@/state/sessionStore";
import { toast } from "sonner";

/**
 * "Branch from here" button.
 *
 * Visible only when the timeline scrubber is positioned in the past.
 * On click:
 *   1. POST /sessions/{id}/branch with the timeline timestamp.
 *   2. Plays a ~1s splitting animation: a glowing line traces from the
 *      scrub point upward, while a side panel slides in from the right.
 *   3. Pushes the new branched session into sessionStore and opens the
 *      side panel.
 */
export function BranchButton() {
  const reduceMotion = useReducedMotion();
  const timelineMode = useGraphStore((s) => s.timelineMode);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const branching = useSessionStore((s) => s.branching);
  const setBranching = useSessionStore((s) => s.setBranching);
  const pushBranch = useSessionStore((s) => s.pushBranch);
  const setSidePanelOpen = useSessionStore((s) => s.setSidePanelOpen);

  const visible = timelineMode.active && branching.phase === "idle";

  const onBranch = async () => {
    if (!timelineMode.active || !currentSessionId) return;
    setBranching({
      phase: "splitting",
      from_session_id: currentSessionId,
      at_timestamp: timelineMode.atTimestamp,
    });

    try {
      const url = `${import.meta.env.VITE_BACKEND_URL ?? ""}/sessions/${currentSessionId}/branch`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ at: timelineMode.atTimestamp }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const json = (await res.json()) as { _id: string; name: string };

      pushBranch({
        session_id: json._id,
        name: json.name ?? "Branch",
        branched_at: timelineMode.atTimestamp,
        parent_session_id: currentSessionId,
      });
      setSidePanelOpen(true);

      // hold the splitting animation briefly so the eye sees it
      window.setTimeout(() => {
        setBranching({ phase: "complete", new_session_id: json._id });
        window.setTimeout(() => setBranching({ phase: "idle" }), 400);
      }, 980);
    } catch (err) {
      toast("Branch failed", { description: String(err) });
      setBranching({ phase: "idle" });
    }
  };

  return (
    <>
      <AnimatePresence>
        {visible ? (
          <motion.button
            key="branch-btn"
            type="button"
            onClick={onBranch}
            initial={reduceMotion ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 300, damping: 24 }}
            className="branch-btn"
            aria-label="Branch session from this moment"
          >
            <GitBranch size={14} />
            <span>Branch from here</span>
          </motion.button>
        ) : null}
      </AnimatePresence>

      {/* Splitting animation overlay */}
      <AnimatePresence>
        {branching.phase === "splitting" ? (
          <motion.div
            key="split-overlay"
            className="branch-split-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={reduceMotion ? { duration: 0 } : { duration: 0.2 }}
            aria-hidden
          >
            <motion.div
              className="branch-split-line"
              initial={{ scaleY: 0, opacity: 0.9 }}
              animate={{ scaleY: 1, opacity: 0 }}
              transition={reduceMotion ? { duration: 0 } : springBranch}
            />
            <motion.div
              className="branch-split-glow"
              initial={{ x: 0, opacity: 0.9, scale: 0.8 }}
              animate={{ x: "30vw", opacity: 0, scale: 1.2 }}
              transition={reduceMotion ? { duration: 0 } : springBranch}
            />
          </motion.div>
        ) : null}
      </AnimatePresence>

      <style>{`
        .branch-btn {
          display: inline-flex;
          align-items: center;
          gap: var(--space-2);
          padding: var(--space-2) var(--space-3);
          border-radius: var(--radius-pill);
          background: var(--signature-accent);
          color: var(--text-inverse);
          font-family: var(--font-display);
          font-size: var(--font-size-xs);
          letter-spacing: 0.06em;
          font-weight: 600;
          box-shadow: 0 0 24px var(--signature-accent-glow);
        }
        .branch-btn:hover { box-shadow: 0 0 32px var(--signature-accent-glow); }
        .branch-split-overlay {
          position: fixed;
          inset: 0;
          z-index: var(--z-overlay);
          pointer-events: none;
        }
        .branch-split-line {
          position: absolute;
          left: 50%;
          bottom: 0;
          width: 2px;
          height: 100vh;
          transform-origin: bottom center;
          background: linear-gradient(180deg, transparent, var(--signature-accent) 70%);
          box-shadow: 0 0 32px var(--signature-accent-glow);
        }
        .branch-split-glow {
          position: absolute;
          right: 0;
          top: 50%;
          width: 240px;
          height: 240px;
          border-radius: 999px;
          background: radial-gradient(circle, var(--signature-accent-glow), transparent 60%);
          transform: translateY(-50%);
        }
      `}</style>
    </>
  );
}

export default BranchButton;
