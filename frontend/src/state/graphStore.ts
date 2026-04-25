import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type {
  Edge as ContractEdge,
  GraphEvent,
  Node as ContractNode,
} from "@shared/ws_messages";

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

const SPEAKER_TOKENS = [
  "var(--speaker-1)",
  "var(--speaker-2)",
  "var(--speaker-3)",
  "var(--speaker-4)",
  "var(--speaker-5)",
  "var(--speaker-6)",
];

// ─────────────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────────────

type GraphStore = {
  nodes: Record<string, ContractNode>;
  edges: Record<string, ContractEdge>;
  ghostNodes: Record<string, GhostNode>;
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

  // ── reset ──
  resetGraph: () => void;
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

export const useGraphStore = create<GraphStore>((set, get) => ({
  nodes: {},
  edges: {},
  ghostNodes: {},
  selectedNodeId: null,
  timelineMode: { active: false },
  speakerColors: {},
  activeSpeakerId: null,
  animationQueue: [],

  applyGraphEvent: (e) => {
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

  goLive: () => set({ timelineMode: { active: false } }),

  selectNode: (id) => set({ selectedNodeId: id }),

  ensureSpeakerColor: (speaker_id) => {
    const { speakerColors } = get();
    if (speakerColors[speaker_id]) return speakerColors[speaker_id];
    const next = assignSpeakerColor(speakerColors, speaker_id);
    set({ speakerColors: next });
    return next[speaker_id];
  },

  setActiveSpeaker: (speaker_id) => set({ activeSpeakerId: speaker_id }),

  resetGraph: () =>
    set({
      nodes: {},
      edges: {},
      ghostNodes: {},
      selectedNodeId: null,
      timelineMode: { active: false },
      animationQueue: [],
      speakerColors: {},
      activeSpeakerId: null,
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
