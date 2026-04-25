import { useEffect } from "react";
import { useGraphStore, selectNodeList, selectGhostList } from "@/state/graphStore";
import { useSessionStore } from "@/state/sessionStore";
import { GraphSocketClient } from "@/ws/graphSocketClient";
import { GraphCanvas } from "@/components/graph/GraphCanvas";
import { TopBar } from "@/components/TopBar";
import { TimelineScrubber } from "@/components/TimelineScrubber";
import { SidePanel } from "@/components/SidePanel";
import { SpeakerLegend } from "@/components/SpeakerLegend";
import { EmptyState } from "@/components/EmptyState";
import { NodeEditModal } from "@/components/NodeEditModal";
import { ImageDropZone } from "@/components/ImageDropZone";
import { playClick } from "@/lib/sound";

/**
 * MindMap — App shell.
 *
 * Layout:
 *   ┌─────────── TopBar ────────────┐
 *   │                               │
 *   │       GraphCanvas             │  ← SpeakerLegend (top-right)
 *   │       (or EmptyState)         │
 *   │                               │
 *   │  ┌─── TimelineScrubber ───┐   │
 *   └───────────────────────────────┘
 *           SidePanel (slides from right)
 */
function App() {
  const sessionId = useSessionStore((s) => s.currentSessionId);
  const setSession = useSessionStore((s) => s.setSession);
  const setReducedMotion = useSessionStore((s) => s.setReducedMotion);
  const soundEnabled = useSessionStore((s) => s.soundEnabled);
  const nodes = useGraphStore(selectNodeList);
  const ghosts = useGraphStore(selectGhostList);

  // Bootstrap a session id (from URL or new uuid placeholder).
  useEffect(() => {
    if (sessionId) return;
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get("session");
    const id = fromUrl ?? `local-${Math.random().toString(36).slice(2, 10)}`;
    setSession(id);
  }, [sessionId, setSession]);

  // Connect WS once a session exists.
  useEffect(() => {
    if (!sessionId) return;
    const client = new GraphSocketClient(sessionId);
    client.connect();
    return () => client.close();
  }, [sessionId]);

  // Detect reduced-motion preference.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mq.matches);
    const fn = () => setReducedMotion(mq.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, [setReducedMotion]);

  // Web Audio click on node creation / merge (toggleable).
  useEffect(() => {
    if (!soundEnabled) return;
    const unsub = useGraphStore.subscribe((state, prev) => {
      const nNow = Object.keys(state.nodes).length;
      const nPrev = Object.keys(prev.nodes).length;
      if (nNow > nPrev) playClick({ freq: 880 });
      const gNow = Object.keys(state.ghostNodes).length;
      const gPrev = Object.keys(prev.ghostNodes).length;
      if (gNow < gPrev && nNow === nPrev) playClick({ freq: 660 }); // merge
    });
    return unsub;
  }, [soundEnabled]);

  const showEmpty = nodes.length === 0 && ghosts.length === 0;

  return (
    <div className="app-shell">
      <div className="ambient-bg" aria-hidden />
      <TopBar />
      <main className="app-main">
        <GraphCanvas />
        {showEmpty ? <EmptyState /> : null}
      </main>
      <SpeakerLegend />
      <TimelineScrubber />
      <SidePanel />
      <NodeEditModal />
      <ImageDropZone />

      {import.meta.env.DEV ? <DevHelpers /> : null}

      <style>{`
        .app-main {
          position: absolute;
          inset: 0;
          z-index: 1;
        }
      `}</style>
    </div>
  );
}

/**
 * Dev-only helper: a tiny floating panel to dispatch fake graph events
 * so the UI can be exercised before the backend is wired.
 */
function DevHelpers() {
  const apply = useGraphStore((s) => s.applyGraphEvent);
  const sessionId = useSessionStore((s) => s.currentSessionId) ?? "dev";

  const seedNode = () => {
    const id = `n-${Math.random().toString(36).slice(2, 8)}`;
    apply({
      type: "node_upsert",
      session_id: sessionId,
      node: {
        _id: id,
        session_id: sessionId,
        label: ["Speaker auth", "Idempotency key", "Eventual consistency", "Backpressure"][
          Math.floor(Math.random() * 4)
        ],
        speaker_id: `s${1 + Math.floor(Math.random() * 4)}`,
        importance_score: Math.random(),
        parent_id: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        info: [],
      },
    });
  };

  const seedGhost = () => {
    const ghost_id = `g-${Math.random().toString(36).slice(2, 8)}`;
    apply({
      type: "ghost_node",
      session_id: sessionId,
      ghost_id,
      label: ["Race condition", "Cold start", "Replication lag"][
        Math.floor(Math.random() * 3)
      ],
      speaker_id: `s${1 + Math.floor(Math.random() * 4)}`,
    });
  };

  const solidify = () => {
    const ghosts = Object.values(useGraphStore.getState().ghostNodes);
    const g = ghosts[0];
    if (!g) return;
    const id = `n-${Math.random().toString(36).slice(2, 8)}`;
    apply({
      type: "node_upsert",
      session_id: sessionId,
      resolves_ghost_id: g.ghost_id,
      node: {
        _id: id,
        session_id: sessionId,
        label: g.label,
        speaker_id: g.speaker_id,
        importance_score: 0.6,
        parent_id: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        info: [],
      },
    });
  };

  const seedEdge = () => {
    const all = Object.values(useGraphStore.getState().nodes);
    if (all.length < 2) return;
    const a = all[Math.floor(Math.random() * all.length)];
    let b = all[Math.floor(Math.random() * all.length)];
    while (b._id === a._id) b = all[Math.floor(Math.random() * all.length)];
    apply({
      type: "edge_upsert",
      session_id: sessionId,
      edge: {
        _id: `e-${Math.random().toString(36).slice(2, 8)}`,
        session_id: sessionId,
        source_id: a._id,
        target_id: b._id,
        edge_type: "solid",
        speaker_id: a.speaker_id ?? null,
        created_at: new Date().toISOString(),
      },
    });
  };

  return (
    <div
      style={{
        position: "fixed",
        left: 16,
        bottom: 140,
        zIndex: 200,
        display: "flex",
        gap: 6,
        padding: 8,
        background: "rgba(15,23,42,0.85)",
        border: "1px solid var(--border-subtle)",
        borderRadius: 8,
        fontSize: 11,
        color: "var(--text-secondary)",
        fontFamily: "var(--font-mono)",
      }}
    >
      <span style={{ alignSelf: "center", marginRight: 6 }}>DEV</span>
      <button onClick={seedGhost}>+ghost</button>
      <button onClick={solidify}>solidify</button>
      <button onClick={seedNode}>+node</button>
      <button onClick={seedEdge}>+edge</button>
      <style>{`
        button {
          padding: 4px 8px;
          background: var(--bg-overlay);
          border-radius: 4px;
          color: var(--text-primary);
          font-family: var(--font-mono);
          font-size: 11px;
        }
        button:hover { background: var(--signature-accent-soft); }
      `}</style>
    </div>
  );
}

export default App;
