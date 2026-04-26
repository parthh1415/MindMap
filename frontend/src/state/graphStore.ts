import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type {
  Edge as ContractEdge,
  GraphEvent,
  Node as ContractNode,
} from "@shared/ws_messages";
import { useSessionStore } from "./sessionStore";

// ─────────────────────────────────────────────────────────────────────
// Local types
// ─────────────────────────────────────────────────────────────────────

export type GhostNode = {
  ghost_id: string;
  label: string;
  speaker_id: string;
  created_at: number; // epoch ms (client)
};

export type TimelineMode =
  | { active: false }
  | { active: true; atTimestamp: string };

// Hex values mirror tokens.css `--speaker-1..6` so they stay in sync
// visually. We store hex (not `var(--speaker-N)`) because the new orb
// gradient uses `color-mix(in srgb, <speakerColor> X%, ...)` and several
// browsers fail silently when a `var()` is nested inside `color-mix()` —
// the whole gradient declaration becomes invalid and the orb body
// renders transparent. With concrete hex strings, `color-mix` resolves
// reliably everywhere.
const SPEAKER_TOKENS = [
  "#ff7849", // copper
  "#ff4ecd", // magenta
  "#ffb547", // amber
  "#5cf2a6", // mint
  "#4dc6e8", // teal
  "#b58cff", // violet
];

// ─────────────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────────────

/** Predictive edge: speculative connection drawn between two graph
 *  entities (real or ghost) BEFORE the topology agent confirms it.
 *  Rendered visually distinct (faint, slow-pulsing) and pruned when
 *  superseded by a real `edge_upsert` or after a TTL. */
export type PredictiveEdge = {
  id: string;            // synthetic id
  source_id: string;     // node id OR ghost_id
  target_id: string;
  speaker_id: string;
  created_at: number;    // epoch ms
};

/** A trail point — the most recent node/ghost the active speaker
 *  "touched". Drawn as a thin line connecting their last 2-3 concepts
 *  to telegraph conversational momentum. */
export type SpeakerTrailPoint = {
  entity_id: string;     // node id OR ghost_id
  speaker_id: string;
  ts: number;            // epoch ms
};

type GraphStore = {
  nodes: Record<string, ContractNode>;
  edges: Record<string, ContractEdge>;
  ghostNodes: Record<string, GhostNode>;
  predictiveEdges: Record<string, PredictiveEdge>;
  speakerTrails: Record<string, SpeakerTrailPoint[]>; // per speaker, most recent first
  selectedNodeId: string | null;
  timelineMode: TimelineMode;
  speakerColors: Record<string, string>; // speaker_id → CSS var
  activeSpeakerId: string | null;
  animationQueue: string[]; // node ids queued for staggered mount

  // ── apply WS events ──
  applyGraphEvent: (e: GraphEvent) => void;

  // ── ghost lifecycle ──
  addGhost: (label: string, speaker_id: string) => string;
  removeGhost: (ghost_id: string) => void;
  solidifyGhost: (ghost_id: string, node: ContractNode) => void;
  mergeGhost: (ghost_id: string, into_id: string) => void;

  // ── timeline ──
  setTimelineSnapshot: (
    nodes: ContractNode[],
    edges: ContractEdge[],
    atTimestamp: string,
  ) => void;
  goLive: () => void;

  // ── selection ──
  selectNode: (id: string | null) => void;

  // ── speaker bookkeeping ──
  ensureSpeakerColor: (speaker_id: string) => string;
  setActiveSpeaker: (speaker_id: string | null) => void;

  // ── predictive edges (option D) ──
  addPredictiveEdge: (e: Omit<PredictiveEdge, "id" | "created_at">) => string;
  removePredictiveEdge: (id: string) => void;
  clearPredictiveEdgesFor: (entity_id: string) => void;

  // ── speaker trails (option D) ──
  pushSpeakerTrail: (speaker_id: string, entity_id: string) => void;

  // ── reset ──
  resetGraph: () => void;

  // ── activated nodes (used by AR/3D view; pinch toggles membership) ──
  activatedNodeIds: Set<string>;
  toggleActivated: (node_id: string) => void;
};

let _ghostCounter = 0;
function nextGhostId(): string {
  _ghostCounter += 1;
  return `ghost-${Date.now().toString(36)}-${_ghostCounter}`;
}

function assignSpeakerColor(
  current: Record<string, string>,
  speaker_id: string,
): Record<string, string> {
  if (current[speaker_id]) return current;
  const idx = Object.keys(current).length % SPEAKER_TOKENS.length;
  return { ...current, [speaker_id]: SPEAKER_TOKENS[idx] };
}

let _predictiveCounter = 0;
const nextPredictiveId = () =>
  `pe-${Date.now().toString(36)}-${++_predictiveCounter}`;

const TRAIL_LIMIT_PER_SPEAKER = 4;

export const useGraphStore = create<GraphStore>((set, get) => ({
  nodes: {},
  edges: {},
  ghostNodes: {},
  predictiveEdges: {},
  speakerTrails: {},
  selectedNodeId: null,
  timelineMode: { active: false },
  speakerColors: {},
  activeSpeakerId: null,
  animationQueue: [],
  activatedNodeIds: new Set<string>(),

  applyGraphEvent: (e) => {
    // While the user is scrubbed to a past snapshot, live WebSocket
    // events would otherwise bleed future data into the frozen view
    // (a new node arriving from current speech would graft onto the
    // T-30min snapshot, displaying a graph that never existed at any
    // real point in time). Drop them; goLive() refetches the
    // authoritative live state from the server when the user returns.
    if (get().timelineMode.active) return;
    switch (e.type) {
      case "ghost_node": {
        set((s) => ({
          ghostNodes: {
            ...s.ghostNodes,
            [e.ghost_id]: {
              ghost_id: e.ghost_id,
              label: e.label,
              speaker_id: e.speaker_id,
              created_at: Date.now(),
            },
          },
          speakerColors: assignSpeakerColor(s.speakerColors, e.speaker_id),
        }));
        break;
      }
      case "node_upsert": {
        const { node, resolves_ghost_id } = e;
        set((s) => {
          const ghosts = { ...s.ghostNodes };
          if (resolves_ghost_id) delete ghosts[resolves_ghost_id];
          return {
            nodes: { ...s.nodes, [node._id]: node },
            ghostNodes: ghosts,
            speakerColors: node.speaker_id
              ? assignSpeakerColor(s.speakerColors, node.speaker_id)
              : s.speakerColors,
            animationQueue: [...s.animationQueue, node._id],
          };
        });
        break;
      }
      case "node_merge": {
        set((s) => {
          const ghosts = { ...s.ghostNodes };
          delete ghosts[e.ghost_id];
          return { ghostNodes: ghosts };
        });
        break;
      }
      case "edge_upsert": {
        set((s) => ({
          edges: { ...s.edges, [e.edge._id]: e.edge },
        }));
        break;
      }
      case "node_enriched": {
        set((s) => {
          const existing = s.nodes[e.node_id];
          if (!existing) return {};
          return {
            nodes: {
              ...s.nodes,
              [e.node_id]: { ...existing, info: e.info },
            },
          };
        });
        break;
      }
    }
  },

  addGhost: (label, speaker_id) => {
    const ghost_id = nextGhostId();
    set((s) => ({
      ghostNodes: {
        ...s.ghostNodes,
        [ghost_id]: { ghost_id, label, speaker_id, created_at: Date.now() },
      },
      speakerColors: assignSpeakerColor(s.speakerColors, speaker_id),
    }));
    return ghost_id;
  },

  removeGhost: (ghost_id) =>
    set((s) => {
      const ghosts = { ...s.ghostNodes };
      delete ghosts[ghost_id];
      return { ghostNodes: ghosts };
    }),

  solidifyGhost: (ghost_id, node) =>
    set((s) => {
      const ghosts = { ...s.ghostNodes };
      delete ghosts[ghost_id];
      return {
        ghostNodes: ghosts,
        nodes: { ...s.nodes, [node._id]: node },
      };
    }),

  mergeGhost: (ghost_id, _into_id) =>
    set((s) => {
      const ghosts = { ...s.ghostNodes };
      delete ghosts[ghost_id];
      return { ghostNodes: ghosts };
    }),

  setTimelineSnapshot: (nodes, edges, atTimestamp) =>
    set(() => {
      const nodeMap: Record<string, ContractNode> = {};
      for (const n of nodes) nodeMap[n._id] = n;
      const edgeMap: Record<string, ContractEdge> = {};
      for (const e of edges) edgeMap[e._id] = e;
      return {
        nodes: nodeMap,
        edges: edgeMap,
        ghostNodes: {},
        timelineMode: { active: true, atTimestamp },
      };
    }),

  goLive: () => {
    // Re-fetch the authoritative live graph from the server before
    // flipping out of timeline mode. The frozen snapshot stays mounted
    // until the fetch lands, so the user never sees an empty / stale
    // intermediate state. If the fetch fails (network blip), we still
    // flip back to live — subsequent WebSocket events will rebuild the
    // graph organically; better that than stranding the user in a past
    // view they thought they exited.
    const apiBase =
      ((import.meta as unknown as { env?: { VITE_BACKEND_URL?: string } }).env
        ?.VITE_BACKEND_URL ?? "");
    const sessionId = useSessionStore.getState().currentSessionId;

    const finalize = (
      patch: Partial<{
        nodes: Record<string, ContractNode>;
        edges: Record<string, ContractEdge>;
        ghostNodes: Record<string, GhostNode>;
      }> = {},
    ) => {
      set({
        ...patch,
        timelineMode: { active: false },
      });
    };

    if (!sessionId) {
      // No session id available — just flip and let WebSocket events
      // populate the graph as they arrive.
      finalize();
      return;
    }
    void (async () => {
      try {
        const url = `${apiBase}/sessions/${encodeURIComponent(sessionId)}/graph`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`graph ${res.status}`);
        const data = (await res.json()) as {
          nodes: ContractNode[];
          edges: ContractEdge[];
        };
        const nodeMap: Record<string, ContractNode> = {};
        for (const n of data.nodes) nodeMap[n._id] = n;
        const edgeMap: Record<string, ContractEdge> = {};
        for (const e of data.edges) edgeMap[e._id] = e;
        finalize({ nodes: nodeMap, edges: edgeMap, ghostNodes: {} });
      } catch (err) {
        console.warn("[graphStore] goLive refetch failed", err);
        finalize();
      }
    })();
  },

  selectNode: (id) => set({ selectedNodeId: id }),

  ensureSpeakerColor: (speaker_id) => {
    const { speakerColors } = get();
    if (speakerColors[speaker_id]) return speakerColors[speaker_id];
    const next = assignSpeakerColor(speakerColors, speaker_id);
    set({ speakerColors: next });
    return next[speaker_id];
  },

  setActiveSpeaker: (speaker_id) => set({ activeSpeakerId: speaker_id }),

  addPredictiveEdge: ({ source_id, target_id, speaker_id }) => {
    const id = nextPredictiveId();
    set((s) => ({
      predictiveEdges: {
        ...s.predictiveEdges,
        [id]: { id, source_id, target_id, speaker_id, created_at: Date.now() },
      },
    }));
    return id;
  },

  removePredictiveEdge: (id) =>
    set((s) => {
      if (!s.predictiveEdges[id]) return {};
      const next = { ...s.predictiveEdges };
      delete next[id];
      return { predictiveEdges: next };
    }),

  clearPredictiveEdgesFor: (entity_id) =>
    set((s) => {
      const next: Record<string, PredictiveEdge> = {};
      let changed = false;
      for (const [k, v] of Object.entries(s.predictiveEdges)) {
        if (v.source_id === entity_id || v.target_id === entity_id) {
          changed = true;
          continue;
        }
        next[k] = v;
      }
      return changed ? { predictiveEdges: next } : {};
    }),

  pushSpeakerTrail: (speaker_id, entity_id) =>
    set((s) => {
      const prev = s.speakerTrails[speaker_id] ?? [];
      // Skip if this is the same entity as the most-recent point.
      if (prev[0]?.entity_id === entity_id) return {};
      const next = [{ entity_id, speaker_id, ts: Date.now() }, ...prev].slice(
        0,
        TRAIL_LIMIT_PER_SPEAKER,
      );
      return { speakerTrails: { ...s.speakerTrails, [speaker_id]: next } };
    }),

  toggleActivated: (node_id) =>
    set((s) => {
      const next = new Set(s.activatedNodeIds);
      if (next.has(node_id)) next.delete(node_id);
      else next.add(node_id);
      return { activatedNodeIds: next };
    }),

  resetGraph: () =>
    set({
      nodes: {},
      edges: {},
      ghostNodes: {},
      predictiveEdges: {},
      speakerTrails: {},
      selectedNodeId: null,
      timelineMode: { active: false },
      animationQueue: [],
      speakerColors: {},
      activeSpeakerId: null,
      activatedNodeIds: new Set<string>(),
    }),
}));

// Convenience selectors. Plain selector functions (suffixed `Fn`) are kept
// for non-hook reads via `useGraphStore.getState()`. Hook variants use
// `useShallow` so identical-content arrays compare equal — without this,
// `Object.values(...)` returns a fresh reference on every getSnapshot,
// React 18's `useSyncExternalStore` flags it as new state, and the tree
// re-renders infinitely (blank screen).
const nodeListFn = (s: GraphStore) => Object.values(s.nodes);
const edgeListFn = (s: GraphStore) => Object.values(s.edges);
const ghostListFn = (s: GraphStore) => Object.values(s.ghostNodes);

export const selectNodeList = nodeListFn;
export const selectEdgeList = edgeListFn;
export const selectGhostList = ghostListFn;

export const useNodeList = () => useGraphStore(useShallow(nodeListFn));
export const useEdgeList = () => useGraphStore(useShallow(edgeListFn));
export const useGhostList = () => useGraphStore(useShallow(ghostListFn));
