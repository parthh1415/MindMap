import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Eye, X } from "lucide-react";
import { springEntrance, springLayout } from "@/lib/motion";
import { useBranchStore } from "@/state/branchStore";
import { useSessionStore } from "@/state/sessionStore";

function backendUrl(): string {
  const base =
    (import.meta.env?.VITE_BACKEND_URL as string | undefined) ??
    "http://localhost:8000";
  return base.replace(/\/$/, "");
}

interface NodeSummary {
  _id: string;
  label: string;
  speaker_id?: string | null;
}

interface EdgeSummary {
  _id: string;
  source_id: string;
  target_id: string;
  source_label?: string | null;
  target_label?: string | null;
}

interface DiffResponse {
  session_a: string;
  session_b: string;
  only_in_a: { nodes: NodeSummary[]; edges: EdgeSummary[] };
  only_in_b: { nodes: NodeSummary[]; edges: EdgeSummary[] };
  shared: { nodes: NodeSummary[]; edges: EdgeSummary[] };
}

type Highlight = "shared" | "only_a" | "only_b" | "all";

function hashLayout(label: string, w: number, h: number): { x: number; y: number } {
  let h32 = 0;
  for (let i = 0; i < label.length; i++) {
    h32 = ((h32 << 5) - h32 + label.charCodeAt(i)) | 0;
  }
  const x = 24 + ((h32 & 0x7fffffff) % Math.max(1, w - 48));
  const y = 24 + ((h32 >> 12) & 0x7fffffff) % Math.max(1, h - 48);
  return { x, y };
}

interface MiniGraphProps {
  side: "a" | "b";
  nodes: NodeSummary[];
  highlightNodes: Set<string>;
  dimNodes: Set<string>;
}

function MiniGraph({ side, nodes, highlightNodes, dimNodes }: MiniGraphProps) {
  const W = 360;
  const H = 320;
  const layouts = useMemo(
    () =>
      nodes.map((n) => {
        const seed = `${side}::${n.label}`;
        return { node: n, ...hashLayout(seed, W, H) };
      }),
    [nodes, side],
  );

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="diff-mini__svg"
      role="img"
      aria-label={`Branch ${side.toUpperCase()} graph preview`}
    >
      {layouts.map(({ node, x, y }) => {
        const labelKey = (node.label || "").toLowerCase();
        const highlighted = highlightNodes.has(labelKey);
        const dimmed = dimNodes.size > 0 && !highlighted;
        return (
          <motion.g
            key={node._id}
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{
              opacity: dimmed ? 0.18 : 1,
              scale: highlighted ? 1.1 : 1,
            }}
            transition={springLayout}
            style={{ transformOrigin: `${x}px ${y}px` }}
          >
            <circle
              cx={x}
              cy={y}
              r={11}
              fill={
                highlighted
                  ? "var(--signature-accent)"
                  : "var(--bg-elevated)"
              }
              stroke={
                highlighted
                  ? "var(--signature-accent)"
                  : "var(--border-default)"
              }
              strokeWidth={highlighted ? 2 : 1}
            />
            <text
              x={x}
              y={y + 24}
              textAnchor="middle"
              fontSize="10"
              fontFamily="var(--font-body)"
              fill={
                highlighted
                  ? "var(--text-primary)"
                  : "var(--text-tertiary)"
              }
            >
              {node.label?.length > 18
                ? `${node.label.slice(0, 17)}…`
                : node.label}
            </text>
          </motion.g>
        );
      })}
    </svg>
  );
}

/**
 * BranchDiffView — split-screen overlay rendered when
 * branchStore.compareSessionId is set.
 *
 * LEFT: current session graph (mini, read-only)
 * RIGHT: compared session graph (mini, read-only)
 * CENTER: shared / only A / only B toggle chips that highlight nodes.
 *
 * Esc closes. "Promote" on the right opens the compared branch.
 */
export function BranchDiffView() {
  const compareSessionId = useBranchStore((s) => s.compareSessionId);
  const closeCompare = useBranchStore((s) => s.closeCompare);
  const sessionId = useSessionStore((s) => s.currentSessionId);
  const setSession = useSessionStore((s) => s.setSession);
  const reduce = useReducedMotion();

  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [highlight, setHighlight] = useState<Highlight>("all");

  useEffect(() => {
    if (!compareSessionId || !sessionId) {
      setDiff(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setDiff(null);
    void (async () => {
      try {
        const res = await fetch(
          `${backendUrl()}/sessions/${sessionId}/diff/${compareSessionId}`,
        );
        if (!res.ok) throw new Error(`status ${res.status}`);
        const body = (await res.json()) as DiffResponse;
        if (cancelled) return;
        setDiff(body);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[BranchDiffView] fetch failed", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [compareSessionId, sessionId]);

  // Esc closes.
  useEffect(() => {
    if (!compareSessionId) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeCompare();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [compareSessionId, closeCompare]);

  const open = !!compareSessionId;

  const sharedLabels = useMemo(() => {
    return new Set(
      (diff?.shared.nodes ?? []).map((n) => (n.label || "").toLowerCase()),
    );
  }, [diff]);
  const onlyALabels = useMemo(() => {
    return new Set(
      (diff?.only_in_a.nodes ?? []).map((n) => (n.label || "").toLowerCase()),
    );
  }, [diff]);
  const onlyBLabels = useMemo(() => {
    return new Set(
      (diff?.only_in_b.nodes ?? []).map((n) => (n.label || "").toLowerCase()),
    );
  }, [diff]);

  const highlightSetA: Set<string> =
    highlight === "shared"
      ? sharedLabels
      : highlight === "only_a"
      ? onlyALabels
      : highlight === "only_b"
      ? new Set()
      : new Set([
          ...sharedLabels,
          ...onlyALabels,
        ]);
  const highlightSetB: Set<string> =
    highlight === "shared"
      ? sharedLabels
      : highlight === "only_b"
      ? onlyBLabels
      : highlight === "only_a"
      ? new Set()
      : new Set([
          ...sharedLabels,
          ...onlyBLabels,
        ]);
  const dimSetA = highlight === "all" ? new Set<string>() : highlightSetA;
  const dimSetB = highlight === "all" ? new Set<string>() : highlightSetB;

  const promote = () => {
    if (!compareSessionId) return;
    setSession(compareSessionId);
    closeCompare();
  };

  const allANodes = useMemo(() => {
    if (!diff) return [] as NodeSummary[];
    return [...diff.only_in_a.nodes, ...diff.shared.nodes];
  }, [diff]);
  const allBNodes = useMemo(() => {
    if (!diff) return [] as NodeSummary[];
    return [...diff.only_in_b.nodes, ...diff.shared.nodes];
  }, [diff]);

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          key="diff-overlay"
          className="diff-overlay"
          initial={reduce ? { opacity: 0 } : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={reduce ? { duration: 0 } : { duration: 0.18 }}
          role="dialog"
          aria-modal="true"
          aria-label="Branch comparison"
        >
          <div className="diff-scrim" onClick={closeCompare} aria-hidden />

          <motion.div
            className="diff-panel diff-panel--left"
            initial={reduce ? { opacity: 0 } : { x: -40, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { x: -20, opacity: 0 }}
            transition={reduce ? { duration: 0 } : { ...springEntrance, delay: 0.05 }}
          >
            <header className="diff-panel__head">
              <span className="diff-panel__tag">A · CURRENT</span>
              <span className="diff-panel__count tabular">
                {allANodes.length} nodes
              </span>
            </header>
            <div className="diff-mini">
              <MiniGraph
                side="a"
                nodes={allANodes}
                highlightNodes={highlightSetA}
                dimNodes={dimSetA}
              />
            </div>
          </motion.div>

          <motion.div
            className="diff-center"
            initial={reduce ? { opacity: 0 } : { y: 20, opacity: 0, scale: 0.95 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { y: 10, opacity: 0 }}
            transition={reduce ? { duration: 0 } : { ...springEntrance, delay: 0.12 }}
          >
            <button
              type="button"
              className="diff-close"
              aria-label="Close branch comparison"
              onClick={closeCompare}
            >
              <X size={14} />
            </button>
            <div className="diff-toggle" role="tablist" aria-label="Highlight mode">
              <button
                type="button"
                role="tab"
                aria-selected={highlight === "all"}
                className={`diff-chip ${highlight === "all" ? "is-on" : ""}`}
                onClick={() => setHighlight("all")}
              >
                All
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={highlight === "shared"}
                className={`diff-chip ${highlight === "shared" ? "is-on" : ""}`}
                onClick={() => setHighlight("shared")}
              >
                Shared{" "}
                <span className="diff-chip__n tabular">
                  {sharedLabels.size}
                </span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={highlight === "only_a"}
                className={`diff-chip ${highlight === "only_a" ? "is-on" : ""}`}
                onClick={() => setHighlight("only_a")}
              >
                Only A{" "}
                <span className="diff-chip__n tabular">
                  {onlyALabels.size}
                </span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={highlight === "only_b"}
                className={`diff-chip ${highlight === "only_b" ? "is-on" : ""}`}
                onClick={() => setHighlight("only_b")}
              >
                Only B{" "}
                <span className="diff-chip__n tabular">
                  {onlyBLabels.size}
                </span>
              </button>
            </div>
            <div className="diff-arrow" aria-hidden>
              <ArrowRight size={14} />
            </div>
            {loading ? (
              <div className="diff-loading">Computing diff…</div>
            ) : null}
          </motion.div>

          <motion.div
            className="diff-panel diff-panel--right"
            initial={reduce ? { opacity: 0 } : { x: 40, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { x: 20, opacity: 0 }}
            transition={reduce ? { duration: 0 } : { ...springEntrance, delay: 0.05 }}
          >
            <header className="diff-panel__head">
              <span className="diff-panel__tag">B · BRANCH</span>
              <span className="diff-panel__count tabular">
                {allBNodes.length} nodes
              </span>
              <button
                type="button"
                className="diff-promote"
                onClick={promote}
                aria-label="Open this branch as current"
              >
                <Eye size={11} />
                <span>Open this branch</span>
              </button>
            </header>
            <div className="diff-mini">
              <MiniGraph
                side="b"
                nodes={allBNodes}
                highlightNodes={highlightSetB}
                dimNodes={dimSetB}
              />
            </div>
          </motion.div>

          <style>{`
            .diff-overlay {
              position: fixed;
              inset: 0;
              z-index: var(--z-modal);
              display: grid;
              grid-template-columns: 1fr min-content 1fr;
              gap: var(--space-4);
              padding: var(--space-8) var(--space-8);
              align-items: center;
            }
            .diff-scrim {
              position: absolute;
              inset: 0;
              background: var(--bg-scrim);
              backdrop-filter: blur(6px);
              -webkit-backdrop-filter: blur(6px);
            }
            .diff-panel {
              position: relative;
              z-index: 1;
              background: var(--bg-raised);
              border: 1px solid var(--border-subtle);
              border-radius: var(--radius-xl);
              box-shadow: var(--elev-3);
              padding: var(--space-4);
              display: flex;
              flex-direction: column;
              gap: var(--space-3);
              max-height: 80vh;
              overflow: hidden;
            }
            .diff-panel--left {
              border-color: var(--signature-accent-soft);
            }
            .diff-panel--right {
              border-color: var(--border-default);
            }
            .diff-panel__head {
              display: flex;
              align-items: center;
              gap: var(--space-3);
            }
            .diff-panel__tag {
              font-family: var(--font-display);
              font-size: 10px;
              letter-spacing: 0.18em;
              color: var(--text-tertiary);
            }
            .diff-panel__count {
              font-family: var(--font-mono);
              font-size: 11px;
              color: var(--text-secondary);
            }
            .diff-promote {
              margin-left: auto;
              display: inline-flex;
              align-items: center;
              gap: 4px;
              padding: 4px 10px;
              border-radius: var(--radius-pill);
              background: var(--signature-accent);
              color: var(--text-inverse);
              font-family: var(--font-display);
              font-size: 10px;
              letter-spacing: 0.08em;
              font-weight: 600;
              box-shadow: 0 0 14px var(--signature-accent-glow);
            }
            .diff-mini {
              flex: 1;
              border-radius: var(--radius-md);
              background: var(--bg-base);
              border: 1px solid var(--border-subtle);
              overflow: hidden;
              display: grid;
              place-items: center;
              padding: var(--space-3);
            }
            .diff-mini__svg {
              width: 100%;
              height: 100%;
              max-height: 60vh;
            }
            .diff-center {
              position: relative;
              z-index: 1;
              display: flex;
              flex-direction: column;
              align-items: center;
              gap: var(--space-3);
              padding: var(--space-3);
            }
            .diff-toggle {
              display: flex;
              flex-direction: column;
              gap: var(--space-2);
              padding: var(--space-3);
              background: var(--bg-overlay);
              border: 1px solid var(--border-subtle);
              border-radius: var(--radius-lg);
              backdrop-filter: blur(8px);
            }
            .diff-chip {
              display: inline-flex;
              align-items: center;
              gap: var(--space-2);
              padding: 6px 12px;
              border-radius: var(--radius-pill);
              background: transparent;
              border: 1px solid var(--border-subtle);
              color: var(--text-secondary);
              font-family: var(--font-display);
              font-size: var(--fs-xs);
              letter-spacing: 0.06em;
              font-weight: 600;
              white-space: nowrap;
            }
            .diff-chip:hover {
              border-color: var(--border-default);
              color: var(--text-primary);
            }
            .diff-chip.is-on {
              background: var(--signature-accent-soft);
              border-color: var(--signature-accent);
              color: var(--signature-accent);
            }
            .diff-chip__n {
              font-family: var(--font-mono);
              font-size: 10px;
              opacity: 0.7;
            }
            .diff-arrow {
              color: var(--signature-accent);
              opacity: 0.6;
            }
            .diff-loading {
              font-family: var(--font-display);
              font-size: 10px;
              color: var(--text-tertiary);
              letter-spacing: 0.12em;
            }
            .diff-close {
              align-self: flex-end;
              width: 26px; height: 26px;
              border-radius: var(--radius-sm);
              display: grid; place-items: center;
              color: var(--text-tertiary);
              background: var(--bg-overlay);
              border: 1px solid var(--border-subtle);
            }
            .diff-close:hover {
              color: var(--text-primary);
              background: var(--bg-elevated);
            }
          `}</style>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

export default BranchDiffView;
