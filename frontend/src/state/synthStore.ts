import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

export type SynthFormat = "doc" | "email" | "issue" | "summary";

export type SynthResult = {
  title: string;
  markdown: string;
  format: SynthFormat;
};

export type ExpandChild = {
  label: string;
  edge_type: "solid" | "dashed" | "dotted";
  importance_score: number;
};

type SynthStore = {
  // ── Selection (multi-select for cluster synth) ──
  selectedForSynth: Set<string>;

  // ── Drawer ──
  drawerOpen: boolean;
  format: SynthFormat;

  // ── Result ──
  lastResult: SynthResult | null;
  inflight: boolean;
  error: string | null;

  // ── Active "anchor" node (for Expand button float) ──
  anchorNodeId: string | null;

  // ── Backend base URL (lets tests override) ──
  apiBase: string;

  // ── Actions ──
  toggleSelect: (nodeId: string) => void;
  clearSelection: () => void;
  openDrawer: () => void;
  closeDrawer: () => void;
  setFormat: (f: SynthFormat) => void;
  setAnchor: (id: string | null) => void;
  runSynthesis: (sessionId: string) => Promise<void>;
  runExpand: (
    nodeId: string,
    onChildren?: (children: ExpandChild[]) => void,
  ) => Promise<ExpandChild[]>;
  setApiBase: (base: string) => void;
};

const DEFAULT_API_BASE =
  (typeof window !== "undefined" && (window as unknown as { __MINDMAP_API__?: string }).__MINDMAP_API__) ||
  "http://localhost:8000";

export const useSynthStore = create<SynthStore>((set, get) => ({
  selectedForSynth: new Set<string>(),
  drawerOpen: false,
  format: "doc",
  lastResult: null,
  inflight: false,
  error: null,
  anchorNodeId: null,
  apiBase: DEFAULT_API_BASE,

  toggleSelect: (nodeId) =>
    set((s) => {
      const next = new Set(s.selectedForSynth);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return { selectedForSynth: next };
    }),

  clearSelection: () => set({ selectedForSynth: new Set<string>() }),

  openDrawer: () => set({ drawerOpen: true }),
  closeDrawer: () => set({ drawerOpen: false }),
  setFormat: (f) => set({ format: f }),
  setAnchor: (id) => set({ anchorNodeId: id }),
  setApiBase: (base) => set({ apiBase: base }),

  runSynthesis: async (sessionId) => {
    const { apiBase, format, selectedForSynth } = get();
    const scope: "all" | "selected" =
      selectedForSynth.size > 0 ? "selected" : "all";
    const node_ids = scope === "selected" ? Array.from(selectedForSynth) : undefined;

    set({ inflight: true, error: null });
    try {
      const res = await fetch(
        `${apiBase}/sessions/${encodeURIComponent(sessionId)}/synthesize`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ scope, node_ids, format }),
        },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`${res.status} ${text || res.statusText}`);
      }
      const data = (await res.json()) as {
        title: string;
        markdown: string;
        target_format: SynthFormat;
      };
      set({
        lastResult: {
          title: data.title,
          markdown: data.markdown,
          format: data.target_format ?? format,
        },
        inflight: false,
        drawerOpen: true,
      });
    } catch (err) {
      set({
        inflight: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  runExpand: async (nodeId, onChildren) => {
    const { apiBase } = get();
    set({ inflight: true, error: null });
    try {
      const res = await fetch(
        `${apiBase}/nodes/${encodeURIComponent(nodeId)}/expand`,
        { method: "POST" },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`${res.status} ${text || res.statusText}`);
      }
      const data = (await res.json()) as { children: ExpandChild[] };
      const children = data.children ?? [];
      set({ inflight: false });
      onChildren?.(children);
      return children;
    } catch (err) {
      set({
        inflight: false,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  },
}));

// Convenience selectors.
const selectedListFn = (s: SynthStore) => Array.from(s.selectedForSynth);
export const useSelectedSynthList = () =>
  useSynthStore(useShallow(selectedListFn));
