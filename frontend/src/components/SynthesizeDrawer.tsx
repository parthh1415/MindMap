import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  Copy,
  Download,
  ExternalLink,
  FileText,
  GitPullRequestArrow,
  Mail,
  Sparkles,
  X,
} from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { useGraphStore } from "@/state/graphStore";
import { useSessionStore } from "@/state/sessionStore";
import { useSynthStore, type SynthFormat } from "@/state/synthStore";

/**
 * Slide-in synthesis drawer. Three states:
 *   1. selectedForSynth.size > 0 → footer chip is shown ("Synthesize 3 nodes").
 *   2. drawerOpen === true → full drawer visible (covers ~420px from right).
 *   3. inflight → skeleton in the body. Once result lands, render it.
 *
 * The "Generate" button is the visual primary (signature accent volt).
 */
export function SynthesizeDrawer() {
  const reduceMotion = useReducedMotion();

  const drawerOpen = useSynthStore((s) => s.drawerOpen);
  const openDrawer = useSynthStore((s) => s.openDrawer);
  const closeDrawer = useSynthStore((s) => s.closeDrawer);
  const selectedForSynth = useSynthStore((s) => s.selectedForSynth);
  const clearSelection = useSynthStore((s) => s.clearSelection);
  const format = useSynthStore((s) => s.format);
  const setFormat = useSynthStore((s) => s.setFormat);
  const runSynthesis = useSynthStore((s) => s.runSynthesis);
  const inflight = useSynthStore((s) => s.inflight);
  const lastResult = useSynthStore((s) => s.lastResult);
  const error = useSynthStore((s) => s.error);

  const sessionId = useSessionStore((s) => s.currentSessionId);
  const nodes = useGraphStore((s) => s.nodes);

  const selectedThumbs = useMemo(
    () => Array.from(selectedForSynth).map((id) => nodes[id]).filter(Boolean),
    [selectedForSynth, nodes],
  );

  const onGenerate = async () => {
    if (!sessionId) return;
    await runSynthesis(sessionId);
  };

  const onCopy = () => {
    if (!lastResult) return;
    navigator.clipboard?.writeText(lastResult.markdown).catch(() => {});
  };

  const onDownload = () => {
    if (!lastResult) return;
    const blob = new Blob([lastResult.markdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const safeTitle = lastResult.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    a.download = `${safeTitle || "synthesis"}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const onSendToLinear = () => {
    if (!lastResult) return;
    // Linear quick-create URL with title + description.
    // https://linear.app/?title=...&description=...
    const params = new URLSearchParams({
      title: lastResult.title,
      description: lastResult.markdown,
    });
    window.open(`https://linear.app/?${params.toString()}`, "_blank", "noopener");
  };

  const showChip = selectedForSynth.size > 0 && !drawerOpen;

  return (
    <>
      <AnimatePresence>
        {showChip ? (
          <motion.button
            key="synth-chip"
            type="button"
            className="synth-chip"
            onClick={openDrawer}
            initial={reduceMotion ? false : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 240, damping: 28 }}
            data-testid="synth-chip"
            aria-label={`Synthesize ${selectedForSynth.size} selected nodes`}
          >
            <Sparkles size={13} />
            <span className="tabular">
              Synthesize {selectedForSynth.size} node{selectedForSynth.size === 1 ? "" : "s"}
            </span>
          </motion.button>
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {drawerOpen ? (
          <motion.aside
            key="synth-drawer"
            className="synth-drawer"
            initial={reduceMotion ? false : { x: "100%", opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { x: "100%", opacity: 0 }}
            transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 240, damping: 28 }}
            data-testid="synth-drawer"
            role="dialog"
            aria-label="Synthesize selection"
          >
            <header className="synth-drawer__head">
              <div className="synth-drawer__title">
                <Sparkles size={14} />
                <span>Synthesize</span>
              </div>
              <button
                type="button"
                className="synth-drawer__close"
                onClick={closeDrawer}
                aria-label="Close drawer"
              >
                <X size={16} />
              </button>
            </header>

            <section className="synth-drawer__selection">
              <div className="synth-drawer__count tabular">
                {selectedForSynth.size} selected
                {selectedForSynth.size > 0 ? (
                  <button
                    type="button"
                    className="synth-drawer__clear"
                    onClick={clearSelection}
                  >
                    Clear
                  </button>
                ) : (
                  <span className="synth-drawer__hint">Synthesizing all session nodes</span>
                )}
              </div>
              {selectedThumbs.length > 0 ? (
                <ul className="synth-drawer__thumbs">
                  {selectedThumbs.slice(0, 8).map((n) => (
                    <li key={n._id} className="synth-drawer__thumb">
                      {n.label}
                    </li>
                  ))}
                  {selectedThumbs.length > 8 ? (
                    <li className="synth-drawer__thumb synth-drawer__thumb--more">
                      +{selectedThumbs.length - 8}
                    </li>
                  ) : null}
                </ul>
              ) : null}
            </section>

            <section className="synth-drawer__formats">
              <FormatButton current={format} value="doc" onPick={setFormat} icon={<FileText size={13} />}>
                Doc
              </FormatButton>
              <FormatButton current={format} value="email" onPick={setFormat} icon={<Mail size={13} />}>
                Email
              </FormatButton>
              <FormatButton current={format} value="issue" onPick={setFormat} icon={<GitPullRequestArrow size={13} />}>
                Issue
              </FormatButton>
              <FormatButton current={format} value="summary" onPick={setFormat} icon={<Sparkles size={13} />}>
                Summary
              </FormatButton>
            </section>

            <button
              type="button"
              className="synth-drawer__generate"
              onClick={onGenerate}
              disabled={inflight || !sessionId}
              data-testid="synth-generate"
            >
              {inflight ? "Generating…" : "Generate"}
            </button>

            <div className="synth-drawer__body">
              {inflight ? (
                <div className="synth-drawer__skeleton" aria-busy="true">
                  <motion.div
                    className="synth-drawer__skeleton-bar"
                    animate={{ opacity: [0.35, 0.7, 0.35] }}
                    transition={{ repeat: Infinity, duration: 1.4, ease: "easeInOut" }}
                  />
                  <motion.div
                    className="synth-drawer__skeleton-bar short"
                    animate={{ opacity: [0.5, 0.85, 0.5] }}
                    transition={{ repeat: Infinity, duration: 1.4, ease: "easeInOut", delay: 0.2 }}
                  />
                  <motion.div
                    className="synth-drawer__skeleton-bar"
                    animate={{ opacity: [0.35, 0.7, 0.35] }}
                    transition={{ repeat: Infinity, duration: 1.4, ease: "easeInOut", delay: 0.4 }}
                  />
                </div>
              ) : error ? (
                <p className="synth-drawer__error">Synthesis failed: {error}</p>
              ) : lastResult ? (
                <div className="synth-drawer__result" data-testid="synth-result">
                  <h2 className="synth-drawer__result-title">{lastResult.title}</h2>
                  <MarkdownView source={lastResult.markdown} />
                </div>
              ) : (
                <p className="synth-drawer__placeholder">
                  Pick a format and hit Generate.
                </p>
              )}
            </div>

            <footer className="synth-drawer__footer">
              <button
                type="button"
                className="synth-drawer__action"
                onClick={onCopy}
                disabled={!lastResult}
              >
                <Copy size={12} />
                Copy
              </button>
              <button
                type="button"
                className="synth-drawer__action"
                onClick={onDownload}
                disabled={!lastResult}
              >
                <Download size={12} />
                .md
              </button>
              <button
                type="button"
                className="synth-drawer__action"
                onClick={onSendToLinear}
                disabled={!lastResult}
              >
                <ExternalLink size={12} />
                Linear
              </button>
            </footer>

            <style>{`
              .synth-chip {
                position: fixed;
                right: 24px;
                bottom: 24px;
                display: inline-flex;
                align-items: center;
                gap: var(--sp-2);
                padding: var(--sp-2) var(--sp-4);
                border-radius: 999px;
                background: var(--signature-accent);
                color: var(--signature-accent-fg);
                font-family: var(--font-display);
                font-size: var(--fs-xs);
                font-weight: 700;
                letter-spacing: 0.04em;
                border: none;
                cursor: pointer;
                box-shadow: var(--shadow-md), 0 0 24px var(--signature-accent-glow);
                z-index: var(--z-top);
                font-feature-settings: "tnum" 1;
              }
              .synth-drawer {
                position: fixed;
                top: 0;
                right: 0;
                bottom: 0;
                width: min(420px, 92vw);
                background: var(--bg-raised);
                border-left: 1px solid var(--border-default);
                box-shadow: var(--shadow-lg);
                z-index: var(--z-top);
                display: flex;
                flex-direction: column;
                color: var(--text-primary);
                font-family: var(--font-body);
                font-size: var(--fs-base);
                font-feature-settings: "tnum" 1;
              }
              .synth-drawer__head {
                display: flex;
                align-items: center;
                padding: var(--sp-4);
                border-bottom: 1px solid var(--border-subtle);
                gap: var(--sp-2);
              }
              .synth-drawer__title {
                flex: 1;
                display: flex;
                align-items: center;
                gap: var(--sp-2);
                font-family: var(--font-display);
                font-size: var(--fs-md);
                font-weight: 600;
                letter-spacing: 0.04em;
                color: var(--signature-accent);
              }
              .synth-drawer__close {
                background: transparent;
                border: none;
                color: var(--text-tertiary);
                cursor: pointer;
                padding: var(--sp-1);
                border-radius: var(--radius-sm);
                display: flex;
              }
              .synth-drawer__close:hover { color: var(--text-primary); }
              .synth-drawer__selection {
                padding: var(--sp-3) var(--sp-4);
                border-bottom: 1px solid var(--border-subtle);
                display: grid;
                gap: var(--sp-2);
              }
              .synth-drawer__count {
                display: flex;
                align-items: center;
                gap: var(--sp-2);
                font-size: var(--fs-sm);
                color: var(--text-secondary);
              }
              .synth-drawer__clear {
                margin-left: auto;
                background: transparent;
                border: none;
                color: var(--text-tertiary);
                cursor: pointer;
                font-size: var(--fs-xs);
                text-decoration: underline;
              }
              .synth-drawer__hint {
                margin-left: auto;
                font-size: var(--fs-xs);
                color: var(--text-tertiary);
              }
              .synth-drawer__thumbs {
                list-style: none;
                margin: 0;
                padding: 0;
                display: flex;
                flex-wrap: wrap;
                gap: var(--sp-1);
              }
              .synth-drawer__thumb {
                padding: 2px var(--sp-2);
                font-size: var(--fs-xs);
                border-radius: var(--radius-sm);
                background: var(--bg-elevated);
                border: 1px solid var(--border-subtle);
                color: var(--text-secondary);
              }
              .synth-drawer__thumb--more {
                color: var(--signature-accent);
              }
              .synth-drawer__formats {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: var(--sp-2);
                padding: var(--sp-3) var(--sp-4);
                border-bottom: 1px solid var(--border-subtle);
              }
              .synth-drawer__format {
                display: flex;
                align-items: center;
                gap: var(--sp-2);
                padding: var(--sp-2) var(--sp-3);
                background: var(--bg-base);
                border: 1px solid var(--border-subtle);
                border-radius: var(--radius-md);
                color: var(--text-secondary);
                cursor: pointer;
                font-family: inherit;
                font-size: var(--fs-sm);
              }
              .synth-drawer__format:hover { border-color: var(--border-default); color: var(--text-primary); }
              .synth-drawer__format[aria-pressed="true"] {
                background: var(--signature-accent-soft);
                border-color: rgba(214, 255, 58, 0.4);
                color: var(--signature-accent);
              }
              .synth-drawer__generate {
                margin: var(--sp-3) var(--sp-4);
                padding: var(--sp-3) var(--sp-4);
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
              .synth-drawer__generate:disabled {
                opacity: 0.55;
                cursor: not-allowed;
                box-shadow: none;
              }
              .synth-drawer__body {
                flex: 1;
                overflow: auto;
                padding: 0 var(--sp-4) var(--sp-4) var(--sp-4);
              }
              .synth-drawer__skeleton { display: grid; gap: var(--sp-3); padding: var(--sp-3) 0; }
              .synth-drawer__skeleton-bar {
                height: 14px;
                background: var(--bg-elevated);
                border-radius: var(--radius-sm);
              }
              .synth-drawer__skeleton-bar.short { width: 60%; }
              .synth-drawer__placeholder {
                color: var(--text-tertiary);
                font-size: var(--fs-sm);
                margin-top: var(--sp-3);
              }
              .synth-drawer__error {
                color: var(--color-danger);
                font-size: var(--fs-sm);
                margin-top: var(--sp-3);
              }
              .synth-drawer__result-title {
                font-family: var(--font-display);
                font-size: var(--fs-xl);
                font-weight: 700;
                margin: var(--sp-3) 0 var(--sp-2);
                letter-spacing: -0.01em;
              }
              .synth-drawer__footer {
                display: flex;
                gap: var(--sp-2);
                padding: var(--sp-3) var(--sp-4);
                border-top: 1px solid var(--border-subtle);
              }
              .synth-drawer__action {
                flex: 1;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                gap: var(--sp-1);
                padding: var(--sp-2);
                background: var(--bg-base);
                border: 1px solid var(--border-subtle);
                border-radius: var(--radius-md);
                color: var(--text-secondary);
                font-family: inherit;
                font-size: var(--fs-xs);
                cursor: pointer;
              }
              .synth-drawer__action:hover { color: var(--text-primary); border-color: var(--border-default); }
              .synth-drawer__action:disabled { opacity: 0.5; cursor: not-allowed; }

              .md-view h1, .md-view h2, .md-view h3 {
                font-family: var(--font-display);
                font-weight: 700;
                margin: var(--sp-4) 0 var(--sp-2);
                letter-spacing: -0.01em;
              }
              .md-view h1 { font-size: var(--fs-xl); }
              .md-view h2 { font-size: var(--fs-lg); color: var(--signature-accent); }
              .md-view h3 { font-size: var(--fs-md); }
              .md-view p { margin: 0 0 var(--sp-3); line-height: 1.6; color: var(--text-primary); }
              .md-view ul, .md-view ol { margin: 0 0 var(--sp-3) var(--sp-4); padding: 0; }
              .md-view li { margin-bottom: var(--sp-1); line-height: 1.5; }
              .md-view code {
                background: var(--bg-elevated);
                padding: 1px 4px;
                border-radius: var(--radius-sm);
                font-family: var(--font-mono);
                font-size: 0.9em;
              }
              .md-view pre {
                background: var(--bg-base);
                border: 1px solid var(--border-subtle);
                border-radius: var(--radius-md);
                padding: var(--sp-3);
                overflow: auto;
              }
              .md-view pre code { background: transparent; padding: 0; }
              .md-view strong { font-weight: 700; color: var(--text-primary); }
              .md-view em { font-style: italic; }
            `}</style>
          </motion.aside>
        ) : null}
      </AnimatePresence>
    </>
  );
}

function FormatButton({
  current,
  value,
  onPick,
  icon,
  children,
}: {
  current: SynthFormat;
  value: SynthFormat;
  onPick: (v: SynthFormat) => void;
  icon: ReactNode;
  children: ReactNode;
}) {
  const reduceMotion = useReducedMotion();
  const active = current === value;
  return (
    <motion.button
      type="button"
      className="synth-drawer__format"
      onClick={() => onPick(value)}
      aria-pressed={active}
      data-testid={`format-${value}`}
      whileTap={reduceMotion ? undefined : { scale: 0.97 }}
      transition={{ type: "spring", stiffness: 380, damping: 28 }}
    >
      {icon}
      <span>{children}</span>
    </motion.button>
  );
}

// ---------------------------------------------------------------------------
// MarkdownView — strict subset renderer with no HTML pass-through.
// Supports: # ## ###, paragraphs, ul (-, *), ol (1.), bold (**), italic (*),
// inline code (`x`), fenced code blocks (```), checkbox list items.
// ---------------------------------------------------------------------------
type MdNode =
  | { type: "h1" | "h2" | "h3"; text: string }
  | { type: "p"; text: string }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] }
  | { type: "code"; text: string }
  | { type: "blank" };

function parseMarkdown(src: string): MdNode[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: MdNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Fenced code block.
    if (/^```/.test(line)) {
      const block: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        block.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // consume closing fence
      out.push({ type: "code", text: block.join("\n") });
      continue;
    }
    // Headers
    const h1 = /^#\s+(.*)$/.exec(line);
    if (h1) {
      out.push({ type: "h1", text: h1[1] });
      i++;
      continue;
    }
    const h2 = /^##\s+(.*)$/.exec(line);
    if (h2) {
      out.push({ type: "h2", text: h2[1] });
      i++;
      continue;
    }
    const h3 = /^###\s+(.*)$/.exec(line);
    if (h3) {
      out.push({ type: "h3", text: h3[1] });
      i++;
      continue;
    }
    // Unordered list.
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*]\s+/, ""));
        i++;
      }
      out.push({ type: "ul", items });
      continue;
    }
    // Ordered list.
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ""));
        i++;
      }
      out.push({ type: "ol", items });
      continue;
    }
    // Blank line.
    if (line.trim() === "") {
      out.push({ type: "blank" });
      i++;
      continue;
    }
    // Paragraph: gather contiguous non-blank, non-special lines.
    const buf: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(#{1,3}\s+|[-*]\s+|\d+\.\s+|```)/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    out.push({ type: "p", text: buf.join(" ") });
  }
  return out;
}

function renderInline(text: string): ReactNode[] {
  // React text nodes are auto-escaped, so we never set HTML — we never
  // call dangerouslySetInnerHTML. Tokens like `code`, **bold**, *italic*
  // become React elements; everything else is plain text rendered through
  // <span> children which React renders as text content.
  const out: ReactNode[] = [];
  // Split by inline tokens. Keep delimiters.
  const tokens = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g);
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (!t) continue;
    if (/^`[^`]+`$/.test(t)) {
      out.push(<code key={k}>{t.slice(1, -1)}</code>);
    } else if (/^\*\*[^*]+\*\*$/.test(t)) {
      out.push(<strong key={k}>{t.slice(2, -2)}</strong>);
    } else if (/^\*[^*]+\*$/.test(t)) {
      out.push(<em key={k}>{t.slice(1, -1)}</em>);
    } else {
      out.push(<span key={k}>{t}</span>);
    }
  }
  return out;
}

export function MarkdownView({ source }: { source: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return (
    <div className="md-view">
      {blocks.map((b, i) => {
        switch (b.type) {
          case "h1":
            return <h1 key={i}>{renderInline(b.text)}</h1>;
          case "h2":
            return <h2 key={i}>{renderInline(b.text)}</h2>;
          case "h3":
            return <h3 key={i}>{renderInline(b.text)}</h3>;
          case "p":
            return <p key={i}>{renderInline(b.text)}</p>;
          case "ul":
            return (
              <ul key={i}>
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={i}>
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it)}</li>
                ))}
              </ol>
            );
          case "code":
            return (
              <pre key={i}>
                <code>{b.text}</code>
              </pre>
            );
          case "blank":
            return null;
        }
      })}
    </div>
  );
}

export default SynthesizeDrawer;
