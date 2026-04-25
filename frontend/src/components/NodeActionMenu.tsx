import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Layers, ListPlus, FileSearch, Pencil, X } from "lucide-react";
import { useEffect, useState } from "react";
import { springEntrance, springTap } from "@/lib/motion";
import { useGraphStore } from "@/state/graphStore";
import { useSynthStore } from "@/state/synthStore";

/**
 * Compact popover menu surfaced when a node is selected.
 *
 * Items:
 *   - Expand          → POST /nodes/{id}/expand, optimistic ghosts
 *   - Add to synthesis → toggle synthStore.selectedForSynth
 *   - Show evidence   → fetches /nodes/{id}/evidence, inline transcript chunks
 *   - Edit            → keeps selection (NodeEditModal opens via existing flow)
 *
 * Positioned in viewport coords supplied by the caller (top-right of canvas).
 * If you'd rather pin it to the node coordinates, replace the wrapper's
 * style with absolute positioning relative to the GraphCanvas. We use a
 * fixed viewport anchor here to avoid editing GraphCanvas (out of scope).
 */
export type EvidenceChunk = {
  text: string;
  is_match: boolean;
  speaker_id: string | null;
};

type EvidencePayload = {
  node_label: string;
  transcript_chunks: EvidenceChunk[];
};

export function NodeActionMenu() {
  const reduceMotion = useReducedMotion();
  const selectedNodeId = useGraphStore((s) => s.selectedNodeId);
  const node = useGraphStore((s) =>
    selectedNodeId ? s.nodes[selectedNodeId] : null,
  );
  const speakerColors = useGraphStore((s) => s.speakerColors);
  const selectNode = useGraphStore((s) => s.selectNode);
  const addGhost = useGraphStore((s) => s.addGhost);
  const removeGhost = useGraphStore((s) => s.removeGhost);

  const toggleSelect = useSynthStore((s) => s.toggleSelect);
  const selectedForSynth = useSynthStore((s) => s.selectedForSynth);
  const runExpand = useSynthStore((s) => s.runExpand);
  const setAnchor = useSynthStore((s) => s.setAnchor);
  const apiBase = useSynthStore((s) => s.apiBase);

  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [evidence, setEvidence] = useState<EvidencePayload | null>(null);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [expanding, setExpanding] = useState(false);
  const [editClicked, setEditClicked] = useState(false);

  // When the selection changes, reset transient state.
  useEffect(() => {
    setEvidenceOpen(false);
    setEvidence(null);
    setEditClicked(false);
    if (selectedNodeId) setAnchor(selectedNodeId);
  }, [selectedNodeId, setAnchor]);

  if (!node || editClicked) return null;

  const isSelected = selectedForSynth.has(node._id);
  const speakerColor = node.speaker_id
    ? speakerColors[node.speaker_id] ?? "var(--text-secondary)"
    : "var(--text-secondary)";

  const onExpand = async () => {
    if (expanding) return;
    setExpanding(true);
    // Optimistic ghost children: 3 placeholders that vanish when result lands.
    const ghostIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      ghostIds.push(addGhost(`…`, node.speaker_id ?? "speaker_0"));
    }
    try {
      const children = await runExpand(node._id);
      // Remove ghosts; the real children would normally land via the
      // graph WS as new nodes get created downstream. Until that wire is
      // hooked up from synthesis → topology persistence, we surface them
      // as durable ghosts the user can see + read.
      ghostIds.forEach((g) => removeGhost(g));
      children.forEach((c) => {
        addGhost(c.label, node.speaker_id ?? "speaker_0");
      });
    } finally {
      setExpanding(false);
    }
  };

  const onAddToSynth = () => {
    toggleSelect(node._id);
  };

  const onShowEvidence = async () => {
    if (evidenceOpen) {
      setEvidenceOpen(false);
      return;
    }
    setEvidenceLoading(true);
    setEvidenceOpen(true);
    try {
      const res = await fetch(
        `${apiBase}/nodes/${encodeURIComponent(node._id)}/evidence`,
      );
      if (res.ok) {
        const data = (await res.json()) as EvidencePayload;
        setEvidence(data);
      } else {
        setEvidence({ node_label: node.label, transcript_chunks: [] });
      }
    } catch {
      setEvidence({ node_label: node.label, transcript_chunks: [] });
    } finally {
      setEvidenceLoading(false);
    }
  };

  const onEdit = () => {
    // Defer to existing NodeEditModal — it watches selectedNodeId.
    // We hide our own menu but keep selection so the modal stays open.
    setEditClicked(true);
  };

  const onClose = () => {
    selectNode(null);
  };

  return (
    <AnimatePresence>
      <motion.div
        key={`menu-${node._id}`}
        className="node-action-menu"
        initial={reduceMotion ? false : { opacity: 0, y: -6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        transition={reduceMotion ? { duration: 0 } : springEntrance}
        role="menu"
        aria-label={`Actions for ${node.label}`}
      >
        <header className="node-action-menu__head">
          <span
            className="node-action-menu__dot"
            style={{ background: speakerColor }}
            aria-hidden
          />
          <span className="node-action-menu__title">{node.label}</span>
          <button
            type="button"
            className="node-action-menu__close"
            onClick={onClose}
            aria-label="Close menu"
          >
            <X size={12} />
          </button>
        </header>

        <ul className="node-action-menu__list">
          <li>
            <motion.button
              type="button"
              className="node-action-menu__item primary"
              onClick={onExpand}
              whileTap={reduceMotion ? undefined : { scale: 0.97 }}
              transition={springTap}
              disabled={expanding}
              data-testid="action-expand"
            >
              <Layers size={13} />
              <span>{expanding ? "Expanding…" : "Expand"}</span>
            </motion.button>
          </li>
          <li>
            <motion.button
              type="button"
              className={`node-action-menu__item ${isSelected ? "active" : ""}`}
              onClick={onAddToSynth}
              whileTap={reduceMotion ? undefined : { scale: 0.97 }}
              transition={springTap}
              data-testid="action-add-to-synthesis"
            >
              <ListPlus size={13} />
              <span>{isSelected ? "Added to synthesis" : "Add to synthesis"}</span>
            </motion.button>
          </li>
          <li>
            <motion.button
              type="button"
              className="node-action-menu__item"
              onClick={onShowEvidence}
              whileTap={reduceMotion ? undefined : { scale: 0.97 }}
              transition={springTap}
              data-testid="action-show-evidence"
            >
              <FileSearch size={13} />
              <span>{evidenceOpen ? "Hide evidence" : "Show evidence"}</span>
            </motion.button>
          </li>
          <li>
            <motion.button
              type="button"
              className="node-action-menu__item"
              onClick={onEdit}
              whileTap={reduceMotion ? undefined : { scale: 0.97 }}
              transition={springTap}
              data-testid="action-edit"
            >
              <Pencil size={13} />
              <span>Edit</span>
            </motion.button>
          </li>
        </ul>

        <AnimatePresence>
          {evidenceOpen ? (
            <motion.div
              key="evidence"
              className="node-action-menu__evidence"
              initial={reduceMotion ? false : { opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 240, damping: 28 }}
            >
              {evidenceLoading ? (
                <p className="node-action-menu__loading">Loading evidence…</p>
              ) : evidence && evidence.transcript_chunks.length > 0 ? (
                <ul className="node-action-menu__chunks">
                  {evidence.transcript_chunks.map((c, i) => (
                    <li
                      key={i}
                      className={`node-action-menu__chunk ${c.is_match ? "match" : ""}`}
                    >
                      <span
                        className="node-action-menu__chunk-stripe"
                        style={{ background: speakerColor }}
                        aria-hidden
                      />
                      <span className="node-action-menu__chunk-text">{c.text}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="node-action-menu__empty">No evidence in buffer.</p>
              )}
            </motion.div>
          ) : null}
        </AnimatePresence>

        <style>{`
          .node-action-menu {
            position: fixed;
            top: 80px;
            right: 24px;
            width: 280px;
            background: var(--bg-raised);
            border: 1px solid var(--border-default);
            border-radius: var(--radius-lg);
            box-shadow: var(--shadow-lg);
            z-index: var(--z-top);
            font-family: var(--font-body);
            font-size: var(--fs-sm);
            color: var(--text-primary);
            overflow: hidden;
          }
          .node-action-menu__head {
            display: flex;
            align-items: center;
            gap: var(--sp-2);
            padding: var(--sp-3);
            border-bottom: 1px solid var(--border-subtle);
            background: var(--bg-overlay);
          }
          .node-action-menu__dot {
            width: 8px;
            height: 8px;
            border-radius: 999px;
            flex-shrink: 0;
          }
          .node-action-menu__title {
            flex: 1;
            font-family: var(--font-display);
            font-size: var(--fs-base);
            font-weight: 600;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }
          .node-action-menu__close {
            background: transparent;
            border: none;
            color: var(--text-tertiary);
            cursor: pointer;
            display: flex;
            padding: var(--sp-1);
            border-radius: var(--radius-sm);
          }
          .node-action-menu__close:hover {
            color: var(--text-primary);
            background: var(--bg-elevated);
          }
          .node-action-menu__list {
            list-style: none;
            margin: 0;
            padding: var(--sp-2);
            display: grid;
            gap: 2px;
          }
          .node-action-menu__item {
            width: 100%;
            display: flex;
            align-items: center;
            gap: var(--sp-2);
            padding: var(--sp-2) var(--sp-3);
            background: transparent;
            border: 1px solid transparent;
            border-radius: var(--radius-md);
            color: var(--text-primary);
            cursor: pointer;
            text-align: left;
            font-family: inherit;
            font-size: inherit;
            font-feature-settings: "tnum" 1;
          }
          .node-action-menu__item:hover {
            background: var(--bg-elevated);
            border-color: var(--border-subtle);
          }
          .node-action-menu__item.primary {
            color: var(--signature-accent);
          }
          .node-action-menu__item.active {
            background: var(--signature-accent-soft);
            border-color: rgba(214, 255, 58, 0.32);
            color: var(--signature-accent);
          }
          .node-action-menu__item:disabled {
            opacity: 0.55;
            cursor: progress;
          }
          .node-action-menu__evidence {
            border-top: 1px solid var(--border-subtle);
            padding: var(--sp-2);
            max-height: 240px;
            overflow: auto;
          }
          .node-action-menu__chunks {
            list-style: none;
            margin: 0;
            padding: 0;
            display: grid;
            gap: var(--sp-2);
          }
          .node-action-menu__chunk {
            display: flex;
            gap: var(--sp-2);
            padding: var(--sp-2);
            border-radius: var(--radius-sm);
            background: var(--bg-base);
            border: 1px solid var(--border-subtle);
            font-size: var(--fs-xs);
            line-height: 1.45;
            color: var(--text-secondary);
          }
          .node-action-menu__chunk.match {
            background: var(--signature-accent-soft);
            border-color: rgba(214, 255, 58, 0.32);
            color: var(--text-primary);
          }
          .node-action-menu__chunk-stripe {
            width: 3px;
            border-radius: 999px;
            flex-shrink: 0;
          }
          .node-action-menu__chunk-text {
            flex: 1;
          }
          .node-action-menu__loading,
          .node-action-menu__empty {
            margin: 0;
            padding: var(--sp-2) var(--sp-3);
            color: var(--text-tertiary);
            font-size: var(--fs-xs);
          }
        `}</style>
      </motion.div>
    </AnimatePresence>
  );
}

export default NodeActionMenu;
