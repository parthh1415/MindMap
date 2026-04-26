import { motion, useReducedMotion } from "framer-motion";
import { useArtifactStore } from "@/state/artifactStore";
import { useGraphStore } from "@/state/graphStore";

/**
 * Top bar trigger for the Artifact Generator. Chip-styled button with the
 * deliberately-allowed 📄 emoji + "Generate" label. Hidden when the graph
 * has no nodes (nothing to classify yet). Shows a tiny dot when an active
 * artifact has been dismissed without saving — a soft reminder it lives on
 * in /artifacts.
 */
export function ArtifactButton() {
  const reduce = useReducedMotion();
  const phase = useArtifactStore((s) => s.phase);
  const pendingDismissed = useArtifactStore((s) => s.pendingDismissed);
  const openGenerator = useArtifactStore((s) => s.openGenerator);

  const hasNodes = useGraphStore(
    (s) => Object.keys(s.nodes).length > 0,
  );

  if (!hasNodes) return null;

  const busy = phase === "classifying" || phase === "generating";

  return (
    <motion.button
      type="button"
      className="artifact-btn"
      onClick={() => {
        if (!busy) void openGenerator();
      }}
      disabled={busy}
      data-testid="artifact-button"
      aria-label="Generate artifact"
      title="Generate an artifact from this session"
      whileTap={reduce ? undefined : { scale: 0.97 }}
      transition={{ type: "spring", stiffness: 380, damping: 28 }}
    >
      <span className="artifact-btn__icon" aria-hidden>
        📄
      </span>
      <span className="artifact-btn__label">
        {busy ? (phase === "classifying" ? "Reading…" : "Generating…") : "Generate"}
      </span>
      {pendingDismissed && phase === "idle" ? (
        <span className="artifact-btn__dot" aria-label="Unsaved artifact in history" />
      ) : null}

      <style>{`
        .artifact-btn {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 6px 12px;
          border-radius: 999px;
          background: var(--signature-accent);
          border: 1px solid var(--signature-accent);
          color: var(--signature-accent-fg);
          font-family: var(--font-display);
          font-size: var(--fs-xs);
          font-weight: 700;
          letter-spacing: 0.06em;
          cursor: pointer;
          box-shadow: 0 0 18px var(--signature-accent-glow);
          position: relative;
          font-feature-settings: "tnum" 1;
        }
        .artifact-btn:disabled {
          opacity: 0.6;
          cursor: progress;
          box-shadow: none;
        }
        .artifact-btn__icon {
          font-size: 12px;
          line-height: 1;
        }
        .artifact-btn__label {
          line-height: 1;
        }
        .artifact-btn__dot {
          position: absolute;
          top: -2px;
          right: -2px;
          width: 7px;
          height: 7px;
          border-radius: 999px;
          background: var(--color-warning);
          box-shadow: 0 0 8px rgba(255, 181, 71, 0.7);
          border: 1px solid var(--bg-base);
        }
      `}</style>
    </motion.button>
  );
}

export default ArtifactButton;
