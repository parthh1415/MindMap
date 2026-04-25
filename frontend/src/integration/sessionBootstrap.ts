// useSessionBootstrap
//
// On first mount:
//   - reads `?session=<id>` from the URL; if present, hydrates the graph store
//     by GET /sessions/{id}/graph.
//   - if absent, POSTs /sessions to create a fresh session and rewrites the
//     URL so reloads stay sticky.
//
// Hydration uses `setTimelineSnapshot(...)` followed by `goLive()` so the
// store ends in live mode but with the historical nodes already rendered.

import { useEffect } from "react";
import type { Edge, Node } from "@shared/ws_messages";
import { useGraphStore } from "@/state/graphStore";
import { useSessionStore } from "@/state/sessionStore";

function backendUrl(): string {
  const base =
    (import.meta.env.VITE_BACKEND_URL as string | undefined) ??
    "http://localhost:8000";
  return base.replace(/\/$/, "");
}

interface GraphResponse {
  session_id: string;
  nodes: Node[];
  edges: Edge[];
}

interface SessionResponse {
  _id: string;
  name: string;
  created_at: string;
}

async function fetchGraph(sessionId: string): Promise<GraphResponse | null> {
  const res = await fetch(`${backendUrl()}/sessions/${sessionId}/graph`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`fetch graph: ${res.status} ${res.statusText}`);
  return (await res.json()) as GraphResponse;
}

async function createSession(name = "Live"): Promise<SessionResponse> {
  const res = await fetch(`${backendUrl()}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    throw new Error(`create session: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as SessionResponse;
}

function syncUrlSession(id: string): void {
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.get("session") === id) return;
    url.searchParams.set("session", id);
    window.history.replaceState({}, "", url.toString());
  } catch {
    /* noop in non-browser tests */
  }
}

export function useSessionBootstrap(): void {
  const sessionId = useSessionStore((s) => s.currentSessionId);
  const setSession = useSessionStore((s) => s.setSession);

  // 1. Resolve a session id (URL param → existing store value → POST new).
  useEffect(() => {
    if (sessionId) return;

    let cancelled = false;
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get("session");

    if (fromUrl) {
      setSession(fromUrl);
      return;
    }

    void (async () => {
      try {
        const fresh = await createSession("Live");
        if (cancelled) return;
        setSession(fresh._id, fresh.name);
        syncUrlSession(fresh._id);
      } catch (err) {
        console.warn("[sessionBootstrap] failed to create session", err);
        // Fall back to a local placeholder so the rest of the UI can still
        // render; the user can refresh once the backend is reachable.
        if (!cancelled) {
          setSession(`local-${Math.random().toString(36).slice(2, 10)}`);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionId, setSession]);

  // 2. When a session id is set, hydrate the graph from /sessions/{id}/graph.
  useEffect(() => {
    if (!sessionId) return;
    if (sessionId.startsWith("local-")) return; // never hit the backend

    let cancelled = false;
    void (async () => {
      try {
        const graph = await fetchGraph(sessionId);
        if (cancelled) return;
        if (!graph) {
          // 404 — try to create a session with this id by name; fall back to
          // a fresh id if the backend won't accept it.
          try {
            const fresh = await createSession("Live");
            if (cancelled) return;
            setSession(fresh._id, fresh.name);
            syncUrlSession(fresh._id);
          } catch (err) {
            console.warn("[sessionBootstrap] 404 + create failed", err);
          }
          return;
        }
        // Seed the store. Use the timeline snapshot helper because it does a
        // bulk replace; then immediately go live.
        const store = useGraphStore.getState();
        store.setTimelineSnapshot(
          graph.nodes,
          graph.edges,
          new Date().toISOString(),
        );
        store.goLive();
        // Make sure the URL reflects the active session.
        syncUrlSession(sessionId);
      } catch (err) {
        console.warn("[sessionBootstrap] graph hydrate failed", err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionId, setSession]);
}
