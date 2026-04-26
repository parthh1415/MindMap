import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ChevronDown, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ARTIFACT_TYPES,
  useArtifactStore,
  type ArtifactType,
} from "@/state/artifactStore";
import { useGraphStore } from "@/state/graphStore";

const ARTIFACT_LABELS: Record<ArtifactType, string> = {
  prd: "PRD",
  scaffold: "Scaffold",
  decision: "Decision Doc",
  retro: "Retro",
  action: "Action Plan",
  research: "Research Brief",
  debate: "Debate Brief",
  brief: "Brief",
};

const ARTIFACT_BLURBS: Record<ArtifactType, string> = {
  prd: "Product / feature spec",
  scaffold: "Engineering project starter",
  decision: "Comparison & recommendation",
  retro: "What-went-well + actions",
  action: "Goal, milestones, risks",
  research: "Question-driven exploration",
  debate: "Multi-speaker disagreement",
  brief: "General one-pager",
};

/**
 * Classify-confirm modal — shown after `openGenerator()` resolves.
 * Lets the user accept the top classification, override to a different type,
 * add an optional refinement hint, and pin to a past timeline snapshot.
 */
export function ClassifyConfirmModal() {
  const reduce = useReducedMotion();
  const phase = useArtifactStore((s) => s.phase);
  const classifyResult = useArtifactStore((s) => s.classifyResult);
  const overrideType = useArtifactStore((s) => s.overrideType);
  const refinementHint = useArtifactStore((s) => s.refinementHint);
  const atTimestamp = useArtifactStore((s) => s.atTimestamp);
  const setOverrideType = useArtifactStore((s) => s.setOverrideType);
  const setRefinementHint = useArtifactStore((s) => s.setRefinementHint);
  const setAtTimestamp = useArtifactStore((s) => s.setAtTimestamp);
  const generate = useArtifactStore((s) => s.generate);
  const dismiss = useArtifactStore((s) => s.dismiss);

  const nodes = useGraphStore((s) => s.nodes);

  const visible = phase === "confirming" || phase === "classifying";

  const effectiveType: ArtifactType =
    overrideType ?? classifyResult?.top_choice ?? "brief";

  const otherCandidates = useMemo(() => {
    const cs = classifyResult?.candidates ?? [];
    return cs
      .filter((c) => c.type !== classifyResult?.top_choice)
      .slice(0, 2);
  }, [classifyResult]);

  // Gather distinct timestamps from graph nodes for the time-scrub picker.
  const timestamps = useMemo(() => {
    const set = new Set<string>();
    Object.values(nodes).forEach((n) => {
      if (n.created_at) set.add(n.created_at);
    });
    return Array.from(set).sort();
  }, [nodes]);

  const [showOverride, setShowOverride] = useState(false);
  const [showOthers, setShowOthers] = useState(false);

  // Reset transient UI when modal opens fresh.
  useEffect(() => {
    if (phase === "confirming") {
      setShowOverride(false);
      setShowOthers(false);
    }
  }, [phase]);

  // Esc → dismiss; Enter → generate.
  const isClassifying = phase === "classifying";
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        dismiss();
      } else if (e.key === "Enter") {
        // Don't intercept when the user is typing in a textarea/input that
        // wants Enter; allow default behavior in textarea.
        const target = e.target as HTMLElement | null;
        if (target?.tagName === "TEXTAREA") return;
        if (target?.tagName === "INPUT") return;
        if (!isClassifying) {
          e.preventDefault();
          void generate();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, isClassifying, dismiss, generate]);

  return (
    <AnimatePresence>
      {visible ? (
        <motion.div
          key="classify-confirm-backdrop"
          className="classify-backdrop"
          initial={reduce ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduce ? 0 : 0.18 }}
          onClick={dismiss}
          data-testid="classify-backdrop"
        >
          <motion.div
            ref={containerRef}
            className="classify-modal"
            role="dialog"
            aria-label="Confirm artifact type"
            data-testid="classify-modal"
            initial={reduce ? false : { opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
            transition={
              reduce
                ? { duration: 0 }
                : { type: "spring", stiffness: 240, damping: 28 }
            }
            onClick={(e) => e.stopPropagation()}
          >
            <header className="classify-modal__head">
              <span className="classify-modal__title">Generate</span>
              <button
                type="button"
                className="classify-modal__close"
                onClick={dismiss}
                aria-label="Close"
              >
                <X size={14} />
              </button>
            </header>

            {isClassifying || !classifyResult ? (
              <div
                className="classify-modal__loading"
                data-testid="classify-loading"
                aria-busy="true"
              >
                <motion.span
                  className="classify-modal__loading-bar"
                  animate={{ opacity: [0.3, 0.85, 0.3] }}
                  transition={{
                    repeat: Infinity,
                    duration: 1.4,
                    ease: "easeInOut",
                  }}
                />
                <span className="classify-modal__loading-label">
                  Classifying session…
                </span>
              </div>
            ) : (
              <>
                <div className="classify-modal__verdict">
                  <span className="classify-modal__verdict-prefix">
                    This looks like a
                  </span>
                  <div className="classify-modal__type-pill-wrap">
                    <button
                      type="button"
                      className="classify-modal__type-pill"
                      onClick={() => setShowOverride((v) => !v)}
                      aria-haspopup="listbox"
                      aria-expanded={showOverride}
                      data-testid="classify-type-pill"
                    >
                      <span>{ARTIFACT_LABELS[effectiveType]}</span>
                      <ChevronDown size={12} />
                    </button>
                    <AnimatePresence>
                      {showOverride ? (
                        <motion.ul
                          className="classify-modal__type-menu"
                          role="listbox"
                          initial={reduce ? false : { opacity: 0, y: -4 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={reduce ? { opacity: 0 } : { opacity: 0, y: -4 }}
                          transition={
                            reduce
                              ? { duration: 0 }
                              : { type: "spring", stiffness: 380, damping: 30 }
                          }
                          data-testid="classify-override-menu"
                        >
                          {ARTIFACT_TYPES.map((t) => (
                            <li
                              key={t}
                              role="option"
                              aria-selected={effectiveType === t}
                            >
                              <button
                                type="button"
                                className={`classify-modal__type-option ${
                                  effectiveType === t ? "is-active" : ""
                                }`}
                                onClick={() => {
                                  setOverrideType(t);
                                  setShowOverride(false);
                                }}
                                data-testid={`classify-option-${t}`}
                              >
                                <span className="classify-modal__opt-name">
                                  {ARTIFACT_LABELS[t]}
                                </span>
                                <span className="classify-modal__opt-blurb">
                                  {ARTIFACT_BLURBS[t]}
                                </span>
                              </button>
                            </li>
                          ))}
                        </motion.ul>
                      ) : null}
                    </AnimatePresence>
                  </div>
                  <span
                    className="classify-modal__confidence tabular"
                    data-testid="classify-confidence"
                  >
                    {classifyResult.confidence.toFixed(2)} confidence
                  </span>
                </div>

                {classifyResult.candidates[0]?.why ? (
                  <p className="classify-modal__why">
                    <em>{classifyResult.candidates[0].why}</em>
                  </p>
                ) : null}

                {otherCandidates.length > 0 ? (
                  <div className="classify-modal__others">
                    <button
                      type="button"
                      className="classify-modal__others-toggle"
                      onClick={() => setShowOthers((v) => !v)}
                      aria-expanded={showOthers}
                    >
                      <ChevronDown
                        size={11}
                        style={{
                          transform: showOthers ? "rotate(180deg)" : "none",
                          transition: "transform 180ms ease",
                        }}
                      />
                      Other candidates
                    </button>
                    <AnimatePresence>
                      {showOthers ? (
                        <motion.ul
                          className="classify-modal__others-list"
                          initial={reduce ? false : { opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: "auto" }}
                          exit={
                            reduce ? { opacity: 0 } : { opacity: 0, height: 0 }
                          }
                          transition={
                            reduce
                              ? { duration: 0 }
                              : { type: "spring", stiffness: 280, damping: 30 }
                          }
                        >
                          {otherCandidates.map((c) => (
                            <li
                              key={c.type}
                              className="classify-modal__other-row"
                            >
                              <span className="classify-modal__other-type">
                                {ARTIFACT_LABELS[c.type]}
                              </span>
                              <span className="classify-modal__other-score tabular">
                                {c.score.toFixed(2)}
                              </span>
                              <span className="classify-modal__other-why">
                                {c.why}
                              </span>
                            </li>
                          ))}
                        </motion.ul>
                      ) : null}
                    </AnimatePresence>
                  </div>
                ) : null}

                <label className="classify-modal__field">
                  <span className="classify-modal__field-label">
                    Refinement hint
                  </span>
                  <textarea
                    className="classify-modal__textarea"
                    placeholder="more technical / shorter / focus on auth…"
                    value={refinementHint}
                    onChange={(e) => setRefinementHint(e.target.value)}
                    rows={2}
                    data-testid="classify-refinement"
                  />
                </label>

                <label className="classify-modal__field">
                  <span className="classify-modal__field-label">As of</span>
                  <select
                    className="classify-modal__select tabular"
                    value={atTimestamp ?? ""}
                    onChange={(e) =>
                      setAtTimestamp(e.target.value || null)
                    }
                    data-testid="classify-at"
                  >
                    <option value="">Now</option>
                    {timestamps.map((ts) => (
                      <option key={ts} value={ts}>
                        {formatShort(ts)}
                      </option>
                    ))}
                  </select>
                </label>

                <button
                  type="button"
                  className="classify-modal__cta"
                  onClick={() => void generate()}
                  disabled={isClassifying}
                  data-testid="classify-generate"
                >
                  Generate
                </button>
              </>
            )}

            <style>{`
              .classify-backdrop {
                position: fixed;
                inset: 0;
                background: var(--bg-scrim);
                backdrop-filter: blur(6px) saturate(140%);
                -webkit-backdrop-filter: blur(6px) saturate(140%);
                display: grid;
                place-items: center;
                z-index: var(--z-modal);
                padding: var(--sp-4);
              }
              .classify-modal {
                width: min(520px, 100%);
                background: var(--bg-raised);
                border: 1px solid var(--border-default);
                border-radius: var(--radius-xl);
                box-shadow: var(--elev-modal);
                color: var(--text-primary);
                font-family: var(--font-body);
                font-size: var(--fs-base);
                font-feature-settings: "tnum" 1;
                display: grid;
                gap: var(--sp-3);
                padding: var(--sp-4);
              }
              .classify-modal__head {
                display: flex;
                align-items: center;
                justify-content: space-between;
              }
              .classify-modal__title {
                font-family: var(--font-display);
                font-weight: 700;
                font-size: var(--fs-md);
                letter-spacing: 0.08em;
                text-transform: uppercase;
                color: var(--signature-accent);
              }
              .classify-modal__close {
                background: transparent;
                border: none;
                color: var(--text-tertiary);
                cursor: pointer;
                padding: var(--sp-1);
                border-radius: var(--radius-sm);
                display: flex;
              }
              .classify-modal__close:hover { color: var(--text-primary); }
              .classify-modal__loading {
                display: grid;
                gap: var(--sp-2);
                padding: var(--sp-6) var(--sp-2);
              }
              .classify-modal__loading-bar {
                height: 10px;
                width: 100%;
                background: var(--bg-elevated);
                border-radius: var(--radius-sm);
              }
              .classify-modal__loading-label {
                font-size: var(--fs-sm);
                color: var(--text-tertiary);
              }
              .classify-modal__verdict {
                display: flex;
                align-items: center;
                flex-wrap: wrap;
                gap: var(--sp-2);
                font-size: var(--fs-md);
              }
              .classify-modal__verdict-prefix { color: var(--text-secondary); }
              .classify-modal__type-pill-wrap { position: relative; }
              .classify-modal__type-pill {
                display: inline-flex;
                align-items: center;
                gap: 4px;
                padding: 4px 10px;
                border-radius: 999px;
                background: var(--signature-accent-soft);
                border: 1px solid rgba(214, 255, 58, 0.32);
                color: var(--signature-accent);
                font-family: var(--font-display);
                font-weight: 700;
                cursor: pointer;
                font-size: var(--fs-md);
              }
              .classify-modal__type-menu {
                position: absolute;
                top: calc(100% + 6px);
                left: 0;
                z-index: 1;
                min-width: 220px;
                max-height: 320px;
                overflow: auto;
                list-style: none;
                margin: 0;
                padding: var(--sp-1);
                background: var(--bg-elevated);
                border: 1px solid var(--border-default);
                border-radius: var(--radius-md);
                box-shadow: var(--shadow-lg);
                display: grid;
                gap: 2px;
              }
              .classify-modal__type-option {
                display: grid;
                width: 100%;
                gap: 1px;
                padding: 6px var(--sp-2);
                background: transparent;
                border: 1px solid transparent;
                border-radius: var(--radius-sm);
                color: var(--text-primary);
                cursor: pointer;
                text-align: left;
                font-family: inherit;
              }
              .classify-modal__type-option:hover {
                background: var(--bg-overlay);
              }
              .classify-modal__type-option.is-active {
                background: var(--signature-accent-soft);
                color: var(--signature-accent);
              }
              .classify-modal__opt-name {
                font-family: var(--font-display);
                font-size: var(--fs-sm);
                font-weight: 600;
              }
              .classify-modal__opt-blurb {
                font-size: var(--fs-xs);
                color: var(--text-tertiary);
              }
              .classify-modal__confidence {
                margin-left: auto;
                font-family: var(--font-mono);
                font-size: var(--fs-xs);
                color: var(--text-tertiary);
                padding: 2px 8px;
                background: var(--bg-base);
                border: 1px solid var(--border-subtle);
                border-radius: 999px;
              }
              .classify-modal__why {
                margin: 0;
                font-size: var(--fs-sm);
                color: var(--text-secondary);
                line-height: 1.5;
              }
              .classify-modal__others {
                display: grid;
                gap: var(--sp-2);
              }
              .classify-modal__others-toggle {
                display: inline-flex;
                align-items: center;
                gap: 4px;
                background: transparent;
                border: none;
                color: var(--text-tertiary);
                cursor: pointer;
                font-size: var(--fs-xs);
                padding: 2px 0;
                width: max-content;
              }
              .classify-modal__others-toggle:hover { color: var(--text-primary); }
              .classify-modal__others-list {
                list-style: none;
                margin: 0;
                padding: 0;
                display: grid;
                gap: var(--sp-2);
                overflow: hidden;
              }
              .classify-modal__other-row {
                display: grid;
                grid-template-columns: 90px 50px 1fr;
                gap: var(--sp-2);
                font-size: var(--fs-xs);
                color: var(--text-secondary);
                padding: 4px 8px;
                background: var(--bg-base);
                border: 1px solid var(--border-subtle);
                border-radius: var(--radius-sm);
              }
              .classify-modal__other-type {
                font-family: var(--font-display);
                font-weight: 600;
                color: var(--text-primary);
              }
              .classify-modal__other-score {
                font-family: var(--font-mono);
                color: var(--text-tertiary);
              }
              .classify-modal__other-why {
                color: var(--text-tertiary);
              }
              .classify-modal__field {
                display: grid;
                gap: 4px;
              }
              .classify-modal__field-label {
                font-size: var(--fs-xs);
                color: var(--text-tertiary);
                text-transform: uppercase;
                letter-spacing: 0.08em;
                font-family: var(--font-display);
              }
              .classify-modal__textarea, .classify-modal__select {
                width: 100%;
                background: var(--bg-base);
                border: 1px solid var(--border-default);
                border-radius: var(--radius-md);
                color: var(--text-primary);
                font-family: var(--font-body);
                font-size: var(--fs-sm);
                padding: 8px 10px;
                resize: vertical;
              }
              .classify-modal__textarea:focus, .classify-modal__select:focus {
                outline: none;
                border-color: var(--signature-accent);
                box-shadow: 0 0 0 1px var(--signature-accent-soft);
              }
              .classify-modal__cta {
                margin-top: var(--sp-1);
                padding: 10px 14px;
                background: var(--signature-accent);
                border: none;
                border-radius: var(--radius-md);
                color: var(--signature-accent-fg);
                font-family: var(--font-display);
                font-weight: 700;
                font-size: var(--fs-md);
                letter-spacing: 0.06em;
                cursor: pointer;
                box-shadow: 0 0 24px var(--signature-accent-glow);
              }
              .classify-modal__cta:disabled {
                opacity: 0.6;
                cursor: not-allowed;
                box-shadow: none;
              }
            `}</style>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function formatShort(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return iso;
  }
}

export default ClassifyConfirmModal;
