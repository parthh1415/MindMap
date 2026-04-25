// DevPanel — DEV-only debug panel.
//
// Renders nothing in production builds (the entire component body is wrapped
// in `if (!import.meta.env.DEV) return null`). When mounted, exposes buttons
// to drive the live pipeline end-to-end without speaking into the mic:
//
//   - Inject ghost                   → store.addGhost(...)
//   - Inject node_upsert             → store.applyGraphEvent(node_upsert)
//   - Solidify oldest ghost          → store.applyGraphEvent({resolves_ghost_id})
//   - Send fake transcript chunk     → POSTs through the local ghost extractor
//                                      and the backend /ws/transcript bridge
//   - Drive Groq topology now        → opens a transient WS to /ws/transcript
//                                      and sends an is_final transcript chunk
//                                      so the topology agent + Groq round-trip
//
// Hidden behind a `?` toggle in the bottom-right corner. No new design tokens
// introduced — uses neutral grays and the existing --signature-accent var.

import * as React from "react";
import { useState } from "react";
import { useGraphStore } from "@/state/graphStore";
import { useSessionStore } from "@/state/sessionStore";
import { processTranscriptPartial } from "@/lib/optimisticGhosts";

const SAMPLE_GHOSTS = [
  "Latency budget",
  "Zero-trust auth",
  "Eventual consistency",
  "Backpressure",
  "Replication lag",
];

const SAMPLE_TRANSCRIPT =
  "we should think about latency in our cybersecurity model and zero-trust authentication";

function backendWsUrl(path: string): string {
  const base =
    (import.meta.env.VITE_BACKEND_WS_URL as string | undefined) ??
    "ws://localhost:8000";
  return `${base.replace(/\/$/, "")}${path}`;
}

function backendUrl(path: string): string {
  const base =
    (import.meta.env.VITE_BACKEND_URL as string | undefined) ??
    "http://localhost:8000";
  return `${base.replace(/\/$/, "")}${path}`;
}

async function sendTranscriptOverWs(
  sessionId: string,
  text: string,
  isFinal: boolean,
): Promise<void> {
  const url = backendWsUrl("/ws/transcript");
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      try {
        ws.close(1000, "devpanel done");
      } catch {
        /* noop */
      }
      if (err) reject(err);
      else resolve();
    };
    ws.addEventListener("open", () => {
      try {
        ws.send(
          JSON.stringify({
            type: "transcript",
            session_id: sessionId,
            speaker_id: "speaker_dev",
            text,
            is_final: isFinal,
            ts_client: Date.now(),
          }),
        );
        // Give the backend a moment to ack; close shortly after.
        setTimeout(() => finish(), 250);
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
    ws.addEventListener("error", () => {
      finish(new Error("ws error"));
    });
    setTimeout(() => finish(new Error("ws open timeout")), 5000);
  });
}

export function DevPanel(): React.ReactElement | null {
  if (!import.meta.env.DEV) return null;
  return <DevPanelInner />;
}

function DevPanelInner(): React.ReactElement {
  const [open, setOpen] = useState(false);
  const sessionId = useSessionStore((s) => s.currentSessionId);

  const injectGhost = () => {
    const label =
      SAMPLE_GHOSTS[Math.floor(Math.random() * SAMPLE_GHOSTS.length)];
    useGraphStore.getState().addGhost(label, "speaker_dev");
  };

  const injectNode = () => {
    const id = sessionId ?? "dev";
    const nid = `n-${Math.random().toString(36).slice(2, 8)}`;
    useGraphStore.getState().applyGraphEvent({
      type: "node_upsert",
      session_id: id,
      node: {
        _id: nid,
        session_id: id,
        label: `Dev node ${nid.slice(-4)}`,
        speaker_id: "speaker_dev",
        importance_score: 0.5,
        parent_id: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        info: [],
      },
    });
  };

  const solidifyOldest = () => {
    const ghosts = Object.values(useGraphStore.getState().ghostNodes);
    if (ghosts.length === 0) return;
    const oldest = ghosts.reduce((a, b) =>
      a.created_at < b.created_at ? a : b,
    );
    const id = sessionId ?? "dev";
    const nid = `n-${Math.random().toString(36).slice(2, 8)}`;
    useGraphStore.getState().applyGraphEvent({
      type: "node_upsert",
      session_id: id,
      resolves_ghost_id: oldest.ghost_id,
      node: {
        _id: nid,
        session_id: id,
        label: oldest.label,
        speaker_id: oldest.speaker_id,
        importance_score: 0.6,
        parent_id: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        info: [],
      },
    });
  };

  const sendFakeChunk = () => {
    // Run through the local ghost extractor — same code path as the live mic.
    processTranscriptPartial(SAMPLE_TRANSCRIPT, "speaker_dev");
    if (sessionId && !sessionId.startsWith("local-")) {
      void sendTranscriptOverWs(sessionId, SAMPLE_TRANSCRIPT, false).catch(
        (err) => console.warn("[devPanel] partial chunk failed", err),
      );
    }
  };

  const driveGroq = () => {
    if (!sessionId || sessionId.startsWith("local-")) {
      console.warn("[devPanel] no real session id — skipping Groq drive");
      return;
    }
    const t0 = performance.now();
    void sendTranscriptOverWs(sessionId, SAMPLE_TRANSCRIPT, true)
      .then(() => {
        console.log(
          `[devPanel] is_final chunk sent in ${(performance.now() - t0).toFixed(0)}ms — watch for node_upsert events`,
        );
      })
      .catch((err) => {
        console.warn("[devPanel] driveGroq failed; trying HTTP fallback", err);
        void fetch(backendUrl("/internal/topology-diff"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session_id: sessionId,
            new_nodes: [
              {
                label: "Latency budget",
                speaker_id: "speaker_dev",
                importance_score: 0.7,
              },
            ],
            new_edges: [],
            updated_nodes: [],
            removed_node_ids: [],
            removed_edge_ids: [],
          }),
        }).catch((err2) =>
          console.warn("[devPanel] http fallback failed", err2),
        );
      });
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open dev panel"
        style={{
          position: "fixed",
          right: 12,
          bottom: 12,
          zIndex: 200,
          width: 28,
          height: 28,
          borderRadius: 14,
          border: "1px solid rgba(255,255,255,0.15)",
          background: "rgba(15,23,42,0.7)",
          color: "rgba(255,255,255,0.7)",
          fontFamily: "monospace",
          fontSize: 13,
          cursor: "pointer",
        }}
      >
        ?
      </button>
    );
  }

  return (
    <div
      style={{
        position: "fixed",
        right: 12,
        bottom: 12,
        zIndex: 200,
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: 8,
        background: "rgba(15,23,42,0.9)",
        border: "1px solid rgba(255,255,255,0.12)",
        borderRadius: 8,
        fontFamily: "monospace",
        fontSize: 11,
        color: "rgba(255,255,255,0.75)",
        minWidth: 200,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 4,
        }}
      >
        <span style={{ opacity: 0.6 }}>DEV</span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close dev panel"
          style={{
            background: "transparent",
            border: "none",
            color: "rgba(255,255,255,0.6)",
            cursor: "pointer",
            fontSize: 13,
          }}
        >
          ×
        </button>
      </div>
      <DevButton onClick={injectGhost}>Inject ghost</DevButton>
      <DevButton onClick={injectNode}>Inject node_upsert</DevButton>
      <DevButton onClick={solidifyOldest}>Solidify oldest ghost</DevButton>
      <DevButton onClick={sendFakeChunk}>Send fake transcript chunk</DevButton>
      <DevButton onClick={driveGroq}>Drive Groq topology now</DevButton>
      <span style={{ opacity: 0.4, fontSize: 10, marginTop: 4 }}>
        session: {sessionId ? sessionId.slice(0, 8) : "(none)"}
      </span>
    </div>
  );
}

function DevButton({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        textAlign: "left",
        padding: "4px 8px",
        background: "rgba(255,255,255,0.05)",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 4,
        color: "rgba(255,255,255,0.85)",
        fontFamily: "monospace",
        fontSize: 11,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}
