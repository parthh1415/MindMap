import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useGraphStore } from "../src/state/graphStore";
import {
  usePredictiveEdgePruner,
  expiredPredictiveIds,
  findMatchingPredictive,
  getActivePredictive,
} from "../src/lib/predictiveEdges";
import type { Edge } from "../../shared/ws_messages";

function mkEdge(partial: Partial<Edge>): Edge {
  return {
    _id: "e",
    session_id: "s",
    source_id: "a",
    target_id: "b",
    edge_type: "solid",
    speaker_id: null,
    created_at: new Date().toISOString(),
    ...partial,
  } as Edge;
}

describe("predictiveEdges helpers", () => {
  beforeEach(() => useGraphStore.getState().resetGraph());

  it("expiredPredictiveIds returns ids older than ttl", () => {
    const map = {
      young: {
        id: "young",
        source_id: "a",
        target_id: "b",
        speaker_id: "s1",
        created_at: 1000,
      },
      old: {
        id: "old",
        source_id: "c",
        target_id: "d",
        speaker_id: "s1",
        created_at: 100,
      },
    };
    const expired = expiredPredictiveIds(map, 1500, 1000);
    expect(expired).toEqual(["old"]);
  });

  it("findMatchingPredictive matches both directions", () => {
    const map = {
      e1: {
        id: "e1",
        source_id: "a",
        target_id: "b",
        speaker_id: "s1",
        created_at: 0,
      },
      e2: {
        id: "e2",
        source_id: "x",
        target_id: "y",
        speaker_id: "s1",
        created_at: 0,
      },
    };
    expect(findMatchingPredictive(map, "a", "b").map((e) => e.id)).toEqual([
      "e1",
    ]);
    expect(findMatchingPredictive(map, "b", "a").map((e) => e.id)).toEqual([
      "e1",
    ]);
    expect(findMatchingPredictive(map, "a", "z")).toEqual([]);
  });

  it("getActivePredictive returns sorted by created_at", () => {
    const id1 = useGraphStore
      .getState()
      .addPredictiveEdge({ source_id: "a", target_id: "b", speaker_id: "s1" });
    // Force a slight delay so timestamps differ.
    const id2 = useGraphStore
      .getState()
      .addPredictiveEdge({ source_id: "c", target_id: "d", speaker_id: "s1" });
    const list = getActivePredictive(useGraphStore.getState());
    expect(list.length).toBe(2);
    expect(list[0].created_at).toBeLessThanOrEqual(list[1].created_at);
    expect(new Set(list.map((e) => e.id))).toEqual(new Set([id1, id2]));
  });
});

describe("usePredictiveEdgePruner", () => {
  beforeEach(() => {
    useGraphStore.getState().resetGraph();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("prunes predictive edges older than TTL", () => {
    const id = useGraphStore
      .getState()
      .addPredictiveEdge({ source_id: "a", target_id: "b", speaker_id: "s1" });
    expect(useGraphStore.getState().predictiveEdges[id]).toBeDefined();

    const { unmount } = renderHook(() => usePredictiveEdgePruner(2_000));

    // Advance under TTL — still present.
    vi.advanceTimersByTime(1_500);
    expect(useGraphStore.getState().predictiveEdges[id]).toBeDefined();

    // Advance past TTL — pruner should drop it on the next tick.
    vi.advanceTimersByTime(2_000);
    expect(useGraphStore.getState().predictiveEdges[id]).toBeUndefined();

    unmount();
  });

  it("drops predictive edge when matching real edge_upsert arrives", () => {
    const id = useGraphStore
      .getState()
      .addPredictiveEdge({ source_id: "n1", target_id: "n2", speaker_id: "s1" });
    expect(useGraphStore.getState().predictiveEdges[id]).toBeDefined();

    const { unmount } = renderHook(() => usePredictiveEdgePruner(60_000));

    // Real edge with same endpoints arrives.
    useGraphStore.getState().applyGraphEvent({
      type: "edge_upsert",
      session_id: "s",
      edge: mkEdge({ _id: "e1", source_id: "n1", target_id: "n2" }),
    });

    expect(useGraphStore.getState().predictiveEdges[id]).toBeUndefined();
    unmount();
  });

  it("does not drop predictive edge for unrelated edge_upsert", () => {
    const id = useGraphStore
      .getState()
      .addPredictiveEdge({ source_id: "n1", target_id: "n2", speaker_id: "s1" });
    const { unmount } = renderHook(() => usePredictiveEdgePruner(60_000));

    useGraphStore.getState().applyGraphEvent({
      type: "edge_upsert",
      session_id: "s",
      edge: mkEdge({ _id: "e1", source_id: "x", target_id: "y" }),
    });

    expect(useGraphStore.getState().predictiveEdges[id]).toBeDefined();
    unmount();
  });
});
