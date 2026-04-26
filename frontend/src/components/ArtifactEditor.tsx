import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Download, RotateCcw, Save, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useArtifactStore } from "@/state/artifactStore";
import { renderMarkdown, slugify } from "@/lib/markdownRender";
import { downloadFile } from "@/lib/downloadFile";
import { bundleArtifact } from "@/lib/bundleArtifact";
import { ProseStyles } from "@/components/ArtifactPreview";

/**
 * Full-screen split-pane editor. Left: textarea with the raw markdown.
 * Right: live preview rendered through `renderMarkdown`. Each H2 in the
 * preview gets a "Regenerate" affordance that re-asks the backend for that
 * section only.
 */
export function ArtifactEditor() {
  const reduce = useReducedMotion();
  const phase = useArtifactStore((s) => s.phase);
  const artifact = useArtifactStore((s) => s.activeArtifact);
  const setMarkdown = useArtifactStore((s) => s.setActiveArtifactMarkdown);
  const exitEditor = useArtifactStore((s) => s.exitEditor);
  const dismiss = useArtifactStore((s) => s.dismiss);
  const regenerateSection = useArtifactStore((s) => s.regenerateSection);

  const visible = phase === "editing" && !!artifact;

  const [draft, setDraft] = useState(artifact?.markdown ?? "");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [activeAnchor, setActiveAnchor] = useState<string | null>(null);
  const [sectionHint, setSectionHint] = useState("");

  // Reset draft when entering editor for a new artifact.
  useEffect(() => {
    if (visible && artifact) {
      setDraft(artifact.markdown);
      setSavedAt(null);
      setActiveAnchor(null);
      setSectionHint("");
    }
  }, [visible, artifact?._id, artifact?.title]);

  // Keep draft in sync if the store-level markdown changes (e.g. after
  // regenerateSection splices in new content).
  useEffect(() => {
    if (artifact) setDraft(artifact.markdown);
  }, [artifact?.markdown]);

  const html = useMemo(() => renderMarkdown(draft), [draft]);

  const sections = useMemo(() => extractH2(draft), [draft]);

  const onSave = () => {
    setMarkdown(draft);
    setSavedAt(Date.now());
  };

  const onDiscard = () => {
    if (artifact) setDraft(artifact.markdown);
    setSavedAt(null);
  };

  const onDownload = async () => {
    if (!artifact) return;
    if (artifact.artifact_type === "scaffold") {
      const blob = await bundleArtifact({
        markdown: draft,
        files: artifact.files,
      });
      downloadFile("project-scaffold.zip", blob, "application/zip");
    } else {
      downloadFile(
        `${slugify(artifact.title) || "artifact"}.md`,
        draft,
        "text/markdown;charset=utf-8",
      );
    }
  };

  if (!artifact) return null;

  return (
    <AnimatePresence>
      {visible ? (
        <motion.div
          key="art-editor"
          className="art-editor"
          role="dialog"
          aria-label={`Edit ${artifact.title}`}
          data-testid="artifact-editor"
          initial={reduce ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={
            reduce
              ? { duration: 0 }
              : { type: "spring", stiffness: 240, damping: 28 }
          }
        >
          <header className="art-editor__head">
            <div className="art-editor__head-left">
              <span className="art-editor__title">{artifact.title}</span>
              <span className="art-editor__type">{artifact.artifact_type}</span>
              {savedAt ? (
                <span
                  className="art-editor__saved tabular"
                  data-testid="artifact-editor-saved"
                >
                  Saved locally
                </span>
              ) : null}
            </div>
            <div className="art-editor__head-right">
              <button
                type="button"
                className="art-editor__btn"
                onClick={onSave}
                data-testid="artifact-editor-save"
                title="Save edits to local copy"
              >
                <Save size={12} />
                Save
              </button>
              <button
                type="button"
                className="art-editor__btn"
                onClick={() => void onDownload()}
              >
                <Download size={12} />
                Download
              </button>
              <button
                type="button"
                className="art-editor__btn"
                onClick={onDiscard}
                data-testid="artifact-editor-discard"
              >
                <RotateCcw size={12} />
                Discard
              </button>
              <button
                type="button"
                className="art-editor__btn"
                onClick={exitEditor}
              >
                Back
              </button>
              <button
                type="button"
                className="art-editor__btn art-editor__btn--close"
                onClick={dismiss}
                aria-label="Close"
              >
                <X size={14} />
              </button>
            </div>
          </header>

          <div className="art-editor__body">
            <section className="art-editor__pane art-editor__pane--left">
              <textarea
                className="art-editor__textarea"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
                data-testid="artifact-editor-textarea"
                aria-label="Markdown source"
              />
            </section>
            <section className="art-editor__pane art-editor__pane--right">
              {sections.length > 0 ? (
                <div className="art-editor__sections">
                  {sections.map((s) => {
                    const isActive = activeAnchor === s.anchor;
                    return (
                      <div key={s.anchor} className="art-editor__section-row">
                        <a
                          href={`#${s.anchor}`}
                          className="art-editor__section-anchor"
                        >
                          {s.heading}
                        </a>
                        <button
                          type="button"
                          className="art-editor__section-regen"
                          onClick={() => {
                            setActiveAnchor(isActive ? null : s.anchor);
                            setSectionHint("");
                          }}
                          data-testid={`artifact-regen-${s.anchor}`}
                        >
                          Regenerate
                        </button>
                        {isActive ? (
                          <div className="art-editor__section-form">
                            <input
                              type="text"
                              className="art-editor__section-input"
                              placeholder="Optional hint…"
                              value={sectionHint}
                              onChange={(e) => setSectionHint(e.target.value)}
                              data-testid={`artifact-regen-input-${s.anchor}`}
                            />
                            <button
                              type="button"
                              className="art-editor__section-go"
                              onClick={() => {
                                if (sectionHint) {
                                  useArtifactStore
                                    .getState()
                                    .setRefinementHint(sectionHint);
                                }
                                void regenerateSection(s.anchor);
                                setActiveAnchor(null);
                              }}
                              data-testid={`artifact-regen-go-${s.anchor}`}
                            >
                              Go
                            </button>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : null}
              <article
                className="prose art-editor__preview"
                data-testid="artifact-editor-preview"
                dangerouslySetInnerHTML={{ __html: html }}
              />
            </section>
          </div>

          <ProseStyles />
          <style>{`
            .art-editor {
              position: fixed;
              inset: 0;
              z-index: var(--z-modal);
              background: var(--bg-base);
              display: flex;
              flex-direction: column;
              color: var(--text-primary);
              font-feature-settings: "tnum" 1;
            }
            .art-editor__head {
              display: flex;
              align-items: center;
              justify-content: space-between;
              padding: var(--sp-3) var(--sp-4);
              border-bottom: 1px solid var(--border-subtle);
              background: var(--bg-raised);
              gap: var(--sp-3);
            }
            .art-editor__head-left, .art-editor__head-right {
              display: flex;
              align-items: center;
              gap: var(--sp-2);
            }
            .art-editor__title {
              font-family: var(--font-display);
              font-weight: 700;
              font-size: var(--fs-md);
              letter-spacing: -0.01em;
            }
            .art-editor__type {
              font-family: var(--font-mono);
              font-size: var(--fs-xs);
              color: var(--text-tertiary);
              padding: 2px 6px;
              border: 1px solid var(--border-subtle);
              border-radius: var(--radius-sm);
            }
            .art-editor__saved {
              font-family: var(--font-mono);
              font-size: var(--fs-xs);
              color: var(--color-success);
            }
            .art-editor__btn {
              display: inline-flex;
              align-items: center;
              gap: 4px;
              padding: 4px 10px;
              background: var(--bg-base);
              border: 1px solid var(--border-subtle);
              border-radius: var(--radius-sm);
              color: var(--text-secondary);
              font-family: var(--font-body);
              font-size: var(--fs-xs);
              cursor: pointer;
            }
            .art-editor__btn:hover {
              color: var(--text-primary);
              border-color: var(--border-default);
            }
            .art-editor__btn--close {
              background: transparent;
              border-color: transparent;
              color: var(--text-tertiary);
            }
            .art-editor__body {
              flex: 1;
              display: grid;
              grid-template-columns: 1fr 1fr;
              min-height: 0;
            }
            .art-editor__pane {
              min-height: 0;
              overflow: auto;
            }
            .art-editor__pane--left {
              border-right: 1px solid var(--border-subtle);
              padding: var(--sp-3);
              background: var(--bg-base);
            }
            .art-editor__pane--right {
              padding: var(--sp-4);
              background: var(--bg-raised);
            }
            .art-editor__textarea {
              width: 100%;
              height: 100%;
              min-height: 100%;
              background: transparent;
              border: 1px solid var(--border-subtle);
              border-radius: var(--radius-md);
              color: var(--text-primary);
              font-family: var(--font-mono);
              font-size: var(--fs-sm);
              line-height: 1.5;
              padding: var(--sp-3);
              resize: none;
            }
            .art-editor__textarea:focus {
              outline: none;
              border-color: var(--signature-accent);
            }
            .art-editor__sections {
              display: grid;
              gap: var(--sp-1);
              margin-bottom: var(--sp-4);
              padding: var(--sp-2);
              background: var(--bg-base);
              border: 1px solid var(--border-subtle);
              border-radius: var(--radius-md);
            }
            .art-editor__section-row {
              display: flex;
              align-items: center;
              gap: var(--sp-2);
              flex-wrap: wrap;
            }
            .art-editor__section-anchor {
              font-family: var(--font-display);
              font-size: var(--fs-sm);
              color: var(--text-primary);
              text-decoration: none;
              flex: 1;
              min-width: 0;
              overflow: hidden;
              text-overflow: ellipsis;
              white-space: nowrap;
            }
            .art-editor__section-anchor:hover { color: var(--signature-accent); }
            .art-editor__section-regen {
              font-family: var(--font-mono);
              font-size: var(--fs-xs);
              padding: 2px 8px;
              background: transparent;
              border: 1px solid var(--border-subtle);
              border-radius: 999px;
              color: var(--text-tertiary);
              cursor: pointer;
            }
            .art-editor__section-regen:hover {
              color: var(--signature-accent);
              border-color: var(--signature-accent-soft);
            }
            .art-editor__section-form {
              display: flex;
              gap: var(--sp-1);
              flex-basis: 100%;
            }
            .art-editor__section-input {
              flex: 1;
              padding: 4px 8px;
              background: var(--bg-overlay);
              border: 1px solid var(--border-subtle);
              border-radius: var(--radius-sm);
              color: var(--text-primary);
              font-family: var(--font-body);
              font-size: var(--fs-xs);
            }
            .art-editor__section-go {
              padding: 4px 10px;
              background: var(--signature-accent);
              color: var(--signature-accent-fg);
              border: none;
              border-radius: var(--radius-sm);
              font-family: var(--font-display);
              font-weight: 700;
              font-size: var(--fs-xs);
              cursor: pointer;
            }
            .art-editor__preview {
              max-width: 720px;
            }
          `}</style>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function extractH2(md: string): { heading: string; anchor: string }[] {
  const out: { heading: string; anchor: string }[] = [];
  const lines = md.split("\n");
  for (const line of lines) {
    const m = /^##\s+(.+)$/.exec(line);
    if (m) {
      const heading = m[1].trim();
      out.push({ heading, anchor: slugify(heading) });
    }
  }
  return out;
}

export default ArtifactEditor;
