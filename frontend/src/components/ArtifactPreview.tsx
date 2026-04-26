import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Copy, Download, ExternalLink, PenSquare, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useArtifactStore, type ArtifactType } from "@/state/artifactStore";
import { renderMarkdown } from "@/lib/markdownRender";
import { downloadFile } from "@/lib/downloadFile";
import { bundleArtifact } from "@/lib/bundleArtifact";

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

function slugFor(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "artifact"
  );
}

/**
 * Centered preview modal showing the freshly-generated artifact. Sticky
 * toolbar at top: download (zip for scaffold, .md otherwise), copy, open
 * in editor, send to Linear, close.
 */
export function ArtifactPreview() {
  const reduce = useReducedMotion();
  const phase = useArtifactStore((s) => s.phase);
  const artifact = useArtifactStore((s) => s.activeArtifact);
  const enterEditor = useArtifactStore((s) => s.enterEditor);
  const dismiss = useArtifactStore((s) => s.dismiss);

  const visible = phase === "ready" && !!artifact;

  const tabs = useMemo(() => {
    if (!artifact) return [] as { path: string; content: string }[];
    const list: { path: string; content: string }[] = [];
    // Primary always first under "README.md" (or its own slug for non-scaffold).
    const primaryPath =
      artifact.artifact_type === "scaffold" ? "README.md" : "main.md";
    list.push({ path: primaryPath, content: artifact.markdown });
    for (const f of artifact.files) {
      if (f.path.toLowerCase() === "readme.md" && primaryPath === "README.md") {
        continue;
      }
      list.push(f);
    }
    return list;
  }, [artifact]);

  const [activeTab, setActiveTab] = useState(0);
  useEffect(() => {
    setActiveTab(0);
  }, [artifact?._id, artifact?.title]);

  // Esc to close.
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        dismiss();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, dismiss]);

  const tab = tabs[activeTab] ?? tabs[0];
  const html = useMemo(
    () => (tab ? renderMarkdown(tab.content) : ""),
    [tab],
  );

  if (!artifact) return null;

  const onDownload = async () => {
    if (artifact.artifact_type === "scaffold") {
      const blob = await bundleArtifact({
        markdown: artifact.markdown,
        files: artifact.files,
      });
      downloadFile("project-scaffold.zip", blob, "application/zip");
    } else {
      downloadFile(
        `${slugFor(artifact.title)}.md`,
        artifact.markdown,
        "text/markdown;charset=utf-8",
      );
    }
  };

  const onCopy = () => {
    navigator.clipboard?.writeText(artifact.markdown).catch(() => {});
  };

  const onLinear = () => {
    const params = new URLSearchParams({
      title: artifact.title,
      description: artifact.markdown,
    });
    window.open(
      `https://linear.app/new?${params.toString()}`,
      "_blank",
      "noopener",
    );
  };

  return (
    <AnimatePresence>
      {visible ? (
        <motion.div
          key="artifact-preview-backdrop"
          className="art-preview-backdrop"
          initial={reduce ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduce ? 0 : 0.18 }}
          onClick={dismiss}
          data-testid="artifact-preview-backdrop"
        >
          <motion.div
            className="art-preview"
            role="dialog"
            aria-label={artifact.title}
            data-testid="artifact-preview"
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
            <header className="art-preview__head">
              <div className="art-preview__head-left">
                <h2 className="art-preview__title">{artifact.title}</h2>
                <span className="art-preview__type">
                  {ARTIFACT_LABELS[artifact.artifact_type]}
                </span>
              </div>
              <button
                type="button"
                className="art-preview__close"
                onClick={dismiss}
                aria-label="Close"
              >
                <X size={14} />
              </button>
            </header>

            <div className="art-preview__toolbar" role="toolbar">
              <button
                type="button"
                className="art-preview__tool"
                onClick={() => void onDownload()}
                data-testid="artifact-download"
                title={
                  artifact.artifact_type === "scaffold"
                    ? "Download zip"
                    : "Download .md"
                }
              >
                <Download size={12} />
                {artifact.artifact_type === "scaffold" ? "Download .zip" : "Download .md"}
              </button>
              <button
                type="button"
                className="art-preview__tool"
                onClick={onCopy}
                data-testid="artifact-copy"
              >
                <Copy size={12} />
                Copy
              </button>
              <button
                type="button"
                className="art-preview__tool"
                onClick={enterEditor}
                data-testid="artifact-edit"
              >
                <PenSquare size={12} />
                Edit
              </button>
              <button
                type="button"
                className="art-preview__tool"
                onClick={onLinear}
                data-testid="artifact-linear"
              >
                <ExternalLink size={12} />
                Linear
              </button>
            </div>

            {tabs.length > 1 ? (
              <nav
                className="art-preview__tabs"
                role="tablist"
                data-testid="artifact-tabs"
              >
                {tabs.map((t, i) => (
                  <button
                    key={t.path}
                    type="button"
                    role="tab"
                    aria-selected={activeTab === i}
                    className={`art-preview__tab ${
                      activeTab === i ? "is-active" : ""
                    }`}
                    onClick={() => setActiveTab(i)}
                    data-testid={`artifact-tab-${t.path}`}
                  >
                    {t.path}
                  </button>
                ))}
              </nav>
            ) : null}

            <div className="art-preview__body">
              <article
                className="prose"
                data-testid="artifact-prose"
                dangerouslySetInnerHTML={{ __html: html }}
              />
            </div>

            <ProseStyles />
            <style>{`
              .art-preview-backdrop {
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
              .art-preview {
                width: min(560px, 100%);
                max-height: 80vh;
                display: flex;
                flex-direction: column;
                background: var(--bg-raised);
                border: 1px solid var(--border-default);
                border-radius: var(--radius-xl);
                box-shadow: var(--elev-modal);
                color: var(--text-primary);
                font-feature-settings: "tnum" 1;
              }
              .art-preview__head {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: var(--sp-3) var(--sp-4);
                border-bottom: 1px solid var(--border-subtle);
                gap: var(--sp-2);
              }
              .art-preview__head-left {
                display: flex;
                align-items: center;
                gap: var(--sp-2);
                min-width: 0;
              }
              .art-preview__title {
                font-family: var(--font-display);
                font-size: var(--fs-lg);
                font-weight: 700;
                letter-spacing: -0.01em;
                margin: 0;
                color: var(--text-primary);
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                max-width: 360px;
              }
              .art-preview__type {
                font-family: var(--font-display);
                font-size: var(--fs-xs);
                font-weight: 700;
                letter-spacing: 0.08em;
                text-transform: uppercase;
                padding: 2px 8px;
                border-radius: 999px;
                background: var(--signature-accent-soft);
                color: var(--signature-accent);
                border: 1px solid rgba(214, 255, 58, 0.32);
              }
              .art-preview__close {
                background: transparent;
                border: none;
                color: var(--text-tertiary);
                cursor: pointer;
                padding: var(--sp-1);
                border-radius: var(--radius-sm);
                display: flex;
              }
              .art-preview__close:hover { color: var(--text-primary); }
              .art-preview__toolbar {
                position: sticky;
                top: 0;
                display: flex;
                gap: var(--sp-1);
                padding: var(--sp-2) var(--sp-4);
                background: var(--bg-overlay);
                border-bottom: 1px solid var(--border-subtle);
                flex-wrap: wrap;
              }
              .art-preview__tool {
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
              .art-preview__tool:hover {
                color: var(--text-primary);
                border-color: var(--border-default);
              }
              .art-preview__tabs {
                display: flex;
                gap: 0;
                padding: 0 var(--sp-4);
                border-bottom: 1px solid var(--border-subtle);
                overflow-x: auto;
              }
              .art-preview__tab {
                padding: 6px 10px;
                background: transparent;
                border: none;
                border-bottom: 2px solid transparent;
                color: var(--text-tertiary);
                font-family: var(--font-mono);
                font-size: var(--fs-xs);
                cursor: pointer;
              }
              .art-preview__tab.is-active {
                color: var(--signature-accent);
                border-bottom-color: var(--signature-accent);
              }
              .art-preview__body {
                overflow: auto;
                padding: var(--sp-4);
                flex: 1;
              }
            `}</style>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

/**
 * Inline `.prose` typography for any markdown HTML rendered via
 * `renderMarkdown(...)`. Reused by ArtifactPreview and ArtifactEditor.
 */
export function ProseStyles() {
  return (
    <style>{`
      .prose {
        font-family: var(--font-body);
        font-size: var(--fs-base);
        line-height: 1.6;
        color: var(--text-primary);
        font-feature-settings: "tnum" 1;
      }
      .prose h1, .prose h2, .prose h3, .prose h4 {
        font-family: var(--font-display);
        font-weight: 700;
        letter-spacing: -0.01em;
        margin: var(--sp-4) 0 var(--sp-2);
        color: var(--text-primary);
      }
      .prose h1 { font-size: var(--fs-xl); }
      .prose h2 {
        font-size: var(--fs-lg);
        color: var(--signature-accent);
        scroll-margin-top: 60px;
      }
      .prose h3 { font-size: var(--fs-md); color: var(--text-primary); }
      .prose p { margin: 0 0 var(--sp-3); color: var(--text-primary); }
      .prose ul, .prose ol {
        margin: 0 0 var(--sp-3) var(--sp-5);
        padding: 0;
      }
      .prose li { margin-bottom: var(--sp-1); line-height: 1.55; }
      .prose code {
        background: var(--bg-elevated);
        padding: 1px 5px;
        border-radius: var(--radius-sm);
        font-family: var(--font-mono);
        font-size: 0.9em;
      }
      .prose pre {
        background: var(--bg-base);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        padding: var(--sp-3);
        overflow: auto;
        margin: 0 0 var(--sp-3);
      }
      .prose pre code { background: transparent; padding: 0; }
      .prose strong { font-weight: 700; }
      .prose em { font-style: italic; }
      .prose blockquote {
        border-left: 2px solid var(--signature-accent-soft);
        padding-left: var(--sp-3);
        color: var(--text-secondary);
        margin: var(--sp-3) 0;
      }
      .prose a {
        color: var(--signature-accent);
        text-decoration: underline;
        text-decoration-color: var(--signature-accent-soft);
        text-underline-offset: 2px;
      }
      .prose hr {
        border: none;
        border-top: 1px solid var(--border-subtle);
        margin: var(--sp-4) 0;
      }
      .prose table {
        border-collapse: collapse;
        margin: 0 0 var(--sp-3);
        font-size: var(--fs-sm);
      }
      .prose th, .prose td {
        border: 1px solid var(--border-subtle);
        padding: 4px 8px;
        text-align: left;
      }
      .prose th {
        background: var(--bg-overlay);
        font-family: var(--font-display);
      }
    `}</style>
  );
}

export default ArtifactPreview;
