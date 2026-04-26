import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { Check, Image as ImageIcon, Pencil, Trash2, X } from "lucide-react";
import { springEntrance } from "@/lib/motion";
import { useGraphStore } from "@/state/graphStore";
import { useSessionStore } from "@/state/sessionStore";
import { toast } from "sonner";

/**
 * Node edit modal.
 *
 * Hierarchy of actions (per brief):
 *   - PRIMARY (largest, signature accent): "Fix transcription" inline rename
 *   - Secondary: edit info, attach image, change parent, delete
 *
 * Keyboard:
 *   - Escape closes
 *   - Enter saves the rename
 *   - Tab order: rename → info textarea → image → delete → cancel/save
 */
export function NodeEditModal() {
  const selectedNodeId = useGraphStore((s) => s.selectedNodeId);
  if (!selectedNodeId) return null;
  // key={selectedNodeId} forces a fresh mount whenever the user opens
  // a different node — that resets local state (label/info) naturally
  // via React's mount lifecycle instead of the setState-in-effect
  // anti-pattern. No effect needed to "sync prop into state".
  return <NodeEditModalInner key={selectedNodeId} nodeId={selectedNodeId} />;
}

function NodeEditModalInner({ nodeId }: { nodeId: string }) {
  const node = useGraphStore((s) => s.nodes[nodeId] ?? null);
  const selectNode = useGraphStore((s) => s.selectNode);
  const reduceMotion = useReducedMotion();

  // Initial state is derived directly from the node prop. Because this
  // component is mounted fresh per nodeId (see key prop above), the
  // useState initializer runs once with the correct values and stays
  // sticky if the user types.
  const [label, setLabel] = useState(() => node?.label ?? "");
  const [info, setInfo] = useState("");
  const renameRef = useRef<HTMLInputElement>(null);

  // Autofocus on mount only.
  useEffect(() => {
    requestAnimationFrame(() => renameRef.current?.focus());
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        selectNode(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectNode]);

  const close = () => selectNode(null);

  const saveRename = async () => {
    if (!node || !label.trim() || label === node.label) {
      close();
      return;
    }
    try {
      const url = `${import.meta.env.VITE_BACKEND_URL ?? ""}/nodes/${node._id}`;
      await fetch(url, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: label.trim() }),
      });
      // optimistic local update
      useGraphStore.setState((s) => ({
        nodes: { ...s.nodes, [node._id]: { ...node, label: label.trim() } },
      }));
      toast("Label updated", { description: label.trim() });
      close();
    } catch (err) {
      console.error(err);
      toast("Could not save", { description: String(err) });
    }
  };

  const addInfo = async () => {
    if (!node || !info.trim()) return;
    const newInfo = [
      ...node.info,
      { text: info.trim(), created_at: new Date().toISOString() },
    ];
    useGraphStore.setState((s) => ({
      nodes: { ...s.nodes, [node._id]: { ...node, info: newInfo } },
    }));
    setInfo("");
    toast("Note added");
  };

  const onDelete = async () => {
    if (!node) return;
    try {
      const url = `${import.meta.env.VITE_BACKEND_URL ?? ""}/nodes/${node._id}`;
      await fetch(url, { method: "DELETE" });
      useGraphStore.setState((s) => {
        const next = { ...s.nodes };
        delete next[node._id];
        return { nodes: next };
      });
      toast("Node deleted");
      close();
    } catch (err) {
      toast("Delete failed", { description: String(err) });
    }
  };

  const open = !!node;
  const reduce = useSessionStore((s) => s.reducedMotion) || reduceMotion;

  return (
    <AnimatePresence>
      {open && node ? (
        <motion.div
          key="backdrop"
          className="modal-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduce ? 0 : 0.18 }}
          onClick={close}
          aria-modal
          role="dialog"
        >
          <motion.div
            key="modal"
            className="modal-card"
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.95, y: 16 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 8 }}
            transition={reduce ? { duration: 0 } : springEntrance}
            onClick={(e) => e.stopPropagation()}
          >
            <header className="modal-header">
              <span className="modal-eyebrow">EDIT NODE</span>
              <button
                type="button"
                onClick={close}
                aria-label="Close"
                className="modal-icon-btn"
              >
                <X size={16} />
              </button>
            </header>

            <section className="modal-primary">
              <label className="modal-primary__label" htmlFor="node-rename">
                <Pencil size={14} /> Fix transcription
              </label>
              <div className="modal-primary__row">
                <input
                  id="node-rename"
                  ref={renameRef}
                  className="modal-primary__input tabular"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void saveRename();
                    }
                  }}
                  placeholder="Concept name…"
                />
                <button type="button" className="modal-primary__cta" onClick={saveRename}>
                  <Check size={16} /> Save
                </button>
              </div>
            </section>

            <section className="modal-section">
              <h4 className="modal-section__title">Add a note</h4>
              <textarea
                className="modal-textarea"
                rows={3}
                value={info}
                onChange={(e) => setInfo(e.target.value)}
                placeholder="Context, decision, citation…"
              />
              <div className="modal-row-end">
                <button type="button" className="modal-btn-secondary" onClick={addInfo}>
                  Add note
                </button>
              </div>
              {node.info.length > 0 ? (
                <ul className="modal-info-list">
                  {node.info.map((entry, i) => (
                    <li key={i}>
                      <span className="modal-info-list__time tabular">
                        {new Date(entry.created_at).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                      <span>{entry.text}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>

            <footer className="modal-footer">
              <button type="button" className="modal-btn-secondary">
                <ImageIcon size={14} /> Attach image
              </button>
              <button
                type="button"
                className="modal-btn-danger"
                onClick={onDelete}
                aria-label="Delete node"
              >
                <Trash2 size={14} /> Delete
              </button>
            </footer>
          </motion.div>

          <style>{`
            .modal-backdrop {
              position: fixed;
              inset: 0;
              z-index: var(--z-modal);
              background: var(--bg-scrim);
              backdrop-filter: blur(8px);
              display: grid;
              place-items: center;
              padding: var(--space-6);
            }
            .modal-card {
              width: min(560px, 100%);
              background: var(--bg-raised);
              border: 1px solid var(--border-subtle);
              border-radius: var(--radius-lg);
              box-shadow: var(--elev-modal);
              overflow: hidden;
            }
            .modal-header {
              display: flex;
              align-items: center;
              justify-content: space-between;
              padding: var(--space-4) var(--space-5);
              border-bottom: 1px solid var(--border-subtle);
            }
            .modal-eyebrow {
              font-family: var(--font-display);
              font-size: var(--font-size-xs);
              letter-spacing: 0.16em;
              color: var(--text-tertiary);
            }
            .modal-icon-btn {
              width: 28px;
              height: 28px;
              border-radius: var(--radius-sm);
              display: grid;
              place-items: center;
              color: var(--text-secondary);
            }
            .modal-icon-btn:hover { background: var(--bg-overlay); color: var(--text-primary); }
            .modal-primary {
              padding: var(--space-5);
              background: linear-gradient(180deg, rgba(34, 211, 238, 0.04), transparent);
              border-bottom: 1px solid var(--border-subtle);
            }
            .modal-primary__label {
              display: inline-flex;
              gap: var(--space-2);
              align-items: center;
              font-size: var(--font-size-xs);
              letter-spacing: 0.08em;
              color: var(--signature-accent);
              text-transform: uppercase;
              margin-bottom: var(--space-2);
            }
            .modal-primary__row {
              display: flex;
              gap: var(--space-2);
            }
            .modal-primary__input {
              flex: 1;
              padding: var(--space-3) var(--space-4);
              border-radius: var(--radius-md);
              background: var(--bg-base);
              border: 1px solid var(--border-default);
              font-size: var(--font-size-lg);
              font-family: var(--font-display);
              color: var(--text-primary);
            }
            .modal-primary__input:focus-visible {
              border-color: var(--signature-accent);
              box-shadow: 0 0 0 3px var(--signature-accent-glow);
              outline: none;
            }
            .modal-primary__cta {
              display: inline-flex;
              gap: var(--space-1);
              align-items: center;
              padding: var(--space-3) var(--space-4);
              border-radius: var(--radius-md);
              background: var(--signature-accent);
              color: var(--text-inverse);
              font-weight: 600;
              font-size: var(--font-size-sm);
              text-shadow: 0 0 10px rgba(255, 255, 255, 0.2);
            }
            .modal-section {
              padding: var(--space-5);
              border-bottom: 1px solid var(--border-subtle);
            }
            .modal-section__title {
              font-size: var(--font-size-sm);
              color: var(--text-secondary);
              font-weight: 500;
              margin-bottom: var(--space-2);
            }
            .modal-textarea {
              width: 100%;
              padding: var(--space-3);
              border-radius: var(--radius-md);
              background: var(--bg-base);
              border: 1px solid var(--border-subtle);
              color: var(--text-primary);
              font-family: var(--font-body);
              font-size: var(--font-size-sm);
              resize: vertical;
            }
            .modal-textarea:focus-visible {
              border-color: var(--signature-accent);
              outline: none;
            }
            .modal-row-end { display: flex; justify-content: flex-end; margin-top: var(--space-2); }
            .modal-info-list {
              list-style: none;
              margin-top: var(--space-3);
              display: flex;
              flex-direction: column;
              gap: var(--space-2);
            }
            .modal-info-list li {
              display: flex;
              gap: var(--space-3);
              font-size: var(--font-size-sm);
              color: var(--text-secondary);
            }
            .modal-info-list__time {
              color: var(--text-tertiary);
              flex-shrink: 0;
              font-feature-settings: "tnum" 1;
            }
            .modal-footer {
              display: flex;
              justify-content: space-between;
              padding: var(--space-4) var(--space-5);
            }
            .modal-btn-secondary {
              display: inline-flex;
              gap: var(--space-2);
              align-items: center;
              padding: var(--space-2) var(--space-3);
              border-radius: var(--radius-md);
              background: var(--bg-overlay);
              color: var(--text-primary);
              font-size: var(--font-size-sm);
            }
            .modal-btn-secondary:hover { background: var(--bg-surface); }
            .modal-btn-danger {
              display: inline-flex;
              gap: var(--space-2);
              align-items: center;
              padding: var(--space-2) var(--space-3);
              border-radius: var(--radius-md);
              background: transparent;
              border: 1px solid var(--destructive);
              color: var(--destructive);
              font-size: var(--font-size-sm);
            }
            .modal-btn-danger:hover { background: rgba(244, 63, 94, 0.1); }
          `}</style>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

export default NodeEditModal;
