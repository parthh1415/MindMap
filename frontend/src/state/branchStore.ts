// branchStore — zustand store for the "branching universe" feature.
//
// Holds:
//   - branches:        the current session's branches (BranchSummary[])
//   - pivotSuggestions: the latest poll from /pivot-suggestions
//   - dismissedPivotIds: pivots the user explicitly dismissed
//   - compareSessionId: when set, BranchDiffView opens against this id
//   - isProcessing:    best-effort flag set by the topology pipeline so the
//                      pivot poller can defer while the graph is mutating
//
// Pivot id convention: `${session_id}:${timestamp}:${pivot_label}`.

import { create } from "zustand";

export interface PivotPoint {
  timestamp: string; // ISO 8601
  why: string;
  pivot_label: string;
}

export interface BranchSummary {
  _id: string;
  name: string;
  branched_from?: { session_id: string; timestamp?: string } | null;
  created_at?: string;
  node_count: number;
}

export type BranchStore = {
  branches: BranchSummary[];
  pivotSuggestions: PivotPoint[];
  lastPivotPolledAt: number;
  dismissedPivotIds: Set<string>;
  compareSessionId: string | null;
  isProcessing: boolean;

  // actions
  setBranches: (b: BranchSummary[]) => void;
  upsertBranch: (b: BranchSummary) => void;
  removeBranch: (id: string) => void;
  setPivots: (p: PivotPoint[]) => void;
  setLastPolledAt: (t: number) => void;
  dismissPivot: (id: string) => void;
  resetDismissed: () => void;
  openCompare: (sid: string) => void;
  closeCompare: () => void;
  setProcessing: (b: boolean) => void;
};

export function pivotIdFor(sessionId: string, p: PivotPoint): string {
  return `${sessionId}:${p.timestamp}:${p.pivot_label}`;
}

export const useBranchStore = create<BranchStore>((set) => ({
  branches: [],
  pivotSuggestions: [],
  lastPivotPolledAt: 0,
  dismissedPivotIds: new Set<string>(),
  compareSessionId: null,
  isProcessing: false,

  setBranches: (b) => set({ branches: b }),
  upsertBranch: (b) =>
    set((s) => {
      const idx = s.branches.findIndex((x) => x._id === b._id);
      if (idx === -1) return { branches: [b, ...s.branches] };
      const next = s.branches.slice();
      next[idx] = b;
      return { branches: next };
    }),
  removeBranch: (id) =>
    set((s) => ({ branches: s.branches.filter((b) => b._id !== id) })),
  setPivots: (p) => set({ pivotSuggestions: p }),
  setLastPolledAt: (t) => set({ lastPivotPolledAt: t }),
  dismissPivot: (id) =>
    set((s) => {
      const next = new Set(s.dismissedPivotIds);
      next.add(id);
      return { dismissedPivotIds: next };
    }),
  resetDismissed: () => set({ dismissedPivotIds: new Set() }),
  openCompare: (sid) => set({ compareSessionId: sid }),
  closeCompare: () => set({ compareSessionId: null }),
  setProcessing: (b) => set({ isProcessing: b }),
}));

// Convenience selectors.
export const selectVisiblePivots = (sessionId: string | null) =>
  function (s: BranchStore): PivotPoint[] {
    if (!sessionId) return [];
    return s.pivotSuggestions.filter(
      (p) => !s.dismissedPivotIds.has(pivotIdFor(sessionId, p)),
    );
  };
