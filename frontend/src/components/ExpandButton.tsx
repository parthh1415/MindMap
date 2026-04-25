import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { Plus } from "lucide-react";
import { useState } from "react";
import { springEntrance, springTap } from "@/lib/motion";
import { useGraphStore } from "@/state/graphStore";
import { useSynthStore } from "@/state/synthStore";

/**
 * Floating "+" affordance positioned bottom-right. Targets whichever node
 * the user most recently focused (synthStore.anchorNodeId or
 * graphStore.selectedNodeId, in that order of preference).
 *
 * Separately discoverable from the NodeActionMenu so users who dismissed
 * the menu still have a one-click expand path.
 */
export function ExpandButton() {
  const reduceMotion = useReducedMotion();
  const anchorNodeId = useSynthStore((s) => s.anchorNodeId);
  const selectedNodeId = useGraphStore((s) => s.selectedNodeId);
  const node = useGraphStore((s) => {
    const id = anchorNodeId ?? selectedNodeId;
    return id ? s.nodes[id] : null;
  });
  const addGhost = useGraphStore((s) => s.addGhost);
  const removeGhost = useGraphStore((s) => s.removeGhost);
  const runExpand = useSynthStore((s) => s.runExpand);

  const [busy, setBusy] = useState(false);
  const visible = node !== null;

  const onClick = async () => {
    if (!node || busy) return;
    setBusy(true);
    const ghosts: string[] = [];
    for (let i = 0; i < 3; i++) {
      ghosts.push(addGhost("…", node.speaker_id ?? "speaker_0"));
    }
    try {
      const children = await runExpand(node._id);
      ghosts.forEach((g) => removeGhost(g));
      children.forEach((c) =>
        addGhost(c.label, node.speaker_id ?? "speaker_0"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <AnimatePresence>
      {visible ? (
        <motion.button
          key="expand-button"
          type="button"
          className="expand-button"
          onClick={onClick}
          disabled={busy}
          initial={reduceMotion ? false : { opacity: 0, scale: 0.9, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.9, y: 4 }}
          transition={reduceMotion ? { duration: 0 } : springEntrance}
          whileTap={reduceMotion ? undefined : { scale: 0.94 }}
          aria-label={`Expand ${node?.label ?? "node"} into children`}
          data-testid="expand-button"
          {...(busy ? {} : { whileHover: reduceMotion ? undefined : { scale: 1.05 } })}
          // Tap spring already set above; keep tap secondary.
          style={{}}
          // Spring transition for hover/tap.
          // (springTap is used by the inline whileHover transition.)
        >
          <motion.span
            className="expand-button__icon"
            animate={busy ? { rotate: 360 } : { rotate: 0 }}
            transition={busy ? { repeat: Infinity, duration: 1.4, ease: "linear" } : springTap}
          >
            <Plus size={16} strokeWidth={2.4} />
          </motion.span>
          <span className="expand-button__label tabular">
            {busy ? "Expanding…" : "Expand node"}
          </span>
        </motion.button>
      ) : null}

      <style>{`
        .expand-button {
          position: fixed;
          right: 24px;
          bottom: 88px;
          display: inline-flex;
          align-items: center;
          gap: var(--sp-2);
          padding: var(--sp-2) var(--sp-4);
          border-radius: 999px;
          background: var(--bg-raised);
          border: 1px solid var(--border-default);
          color: var(--text-primary);
          font-family: var(--font-display);
          font-size: var(--fs-xs);
          font-weight: 600;
          letter-spacing: 0.04em;
          box-shadow: var(--shadow-md);
          cursor: pointer;
          z-index: var(--z-top);
          font-feature-settings: "tnum" 1;
        }
        .expand-button:hover {
          border-color: rgba(214, 255, 58, 0.4);
          color: var(--signature-accent);
          box-shadow: var(--shadow-md), 0 0 18px var(--signature-accent-glow);
        }
        .expand-button:disabled {
          opacity: 0.7;
          cursor: progress;
        }
        .expand-button__icon {
          display: inline-flex;
          color: var(--signature-accent);
        }
      `}</style>
    </AnimatePresence>
  );
}

export default ExpandButton;
