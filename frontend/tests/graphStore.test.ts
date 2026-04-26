import { describe, it, expect, beforeEach } from "vitest";
import { useGraphStore } from "../src/state/graphStore";
import type { Node, Edge } from "../../shared/ws_messages";

function mkNode(partial: Partial<Node>): Node {
  const now = new Date().toISOString();
  return {
    _id: "x",
    session_id: "s",
    label: "X",
    speaker_id: "s1",
    importance_score: 0.5,
    parent_id: null,
    created_at: now,
    updated_at: now,
    info: [],
    ...partial,
  } as Node;
}

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

describe("graphStore", () => {
  beforeEach(() => useGraphStore.getState().resetGraph());

  it("applies node_upsert and resolves ghost", () => {
    const ghostId = useGraphStore.getState().addGhost("Cache", "s1");
    expect(Object.keys(useGraphStore.getState().ghostNodes).length).toBe(1);
    useGraphStore.getState().applyGraphEvent({
      type: "node_upsert",
      session_id: "s",
      resolves_ghost_id: ghostId,
      node: mkNode({ _id: "n1", label: "Cache" }),
    });
    expect(useGraphStore.getState().ghostNodes[ghostId]).toBeUndefined();
    expect(useGraphStore.getState().nodes["n1"]).toBeDefined();
  });

  it("applies timeline snapshot and tweens (mode active)", () => {
    useGraphStore.getState().setTimelineSnapshot(
      [mkNode({ _id: "n1" }), mkNode({ _id: "n2" })],
      [mkEdge({ _id: "e1", source_id: "n1", target_id: "n2" })],
      "2024-01-01T00:00:00Z",
    );
    const s = useGraphStore.getState();
    expect(Object.keys(s.nodes).length).toBe(2);
    expect(s.timelineMode.active).toBe(true);
    if (s.timelineMode.active) {
      expect(s.timelineMode.atTimestamp).toBe("2024-01-01T00:00:00Z");
    }
  });

  it("assigns deterministic speaker colors in order", () => {
    useGraphStore.getState().applyGraphEvent({
      type: "ghost_node",
      session_id: "s",
      ghost_id: "g1",
      label: "A",
      speaker_id: "alice",
    });
    useGraphStore.getState().applyGraphEvent({
      type: "ghost_node",
      session_id: "s",
      ghost_id: "g2",
      label: "B",
      speaker_id: "bob",
    });
    const colors = useGraphStore.getState().speakerColors;
    expect(colors["alice"]).toBe("#ff7849");
    expect(colors["bob"]).toBe("#ff4ecd");
  });

  it("goLive clears timeline mode", () => {
    useGraphStore.getState().setTimelineSnapshot([], [], "2024-01-01T00:00:00Z");
    useGraphStore.getState().goLive();
    expect(useGraphStore.getState().timelineMode.active).toBe(false);
  });

  it("drops live events while in timeline mode (snapshot view stays clean)", () => {
    // Enter timeline mode with one historical node.
    useGraphStore.getState().setTimelineSnapshot(
      [mkNode({ _id: "old", label: "Old" })],
      [],
      "2024-01-01T00:00:00Z",
    );
    expect(useGraphStore.getState().timelineMode.active).toBe(true);

    // A live event arrives — it MUST NOT graft onto the snapshot view.
    useGraphStore.getState().applyGraphEvent({
      type: "node_upsert",
      session_id: "s",
      node: mkNode({ _id: "live", label: "Live arrival" }),
    });

    const nodes = useGraphStore.getState().nodes;
    expect(nodes["old"]).toBeDefined();
    expect(nodes["live"]).toBeUndefined();
  });

  it("applyGraphEvent works normally after goLive", () => {
    useGraphStore.getState().setTimelineSnapshot([], [], "2024-01-01T00:00:00Z");
    useGraphStore.getState().goLive();
    // After flipping back to live, events apply again.
    useGraphStore.getState().applyGraphEvent({
      type: "node_upsert",
      session_id: "s",
      node: mkNode({ _id: "fresh", label: "Fresh" }),
    });
    expect(useGraphStore.getState().nodes["fresh"]).toBeDefined();
  });

  it("node_enriched updates info", () => {
    useGraphStore.getState().applyGraphEvent({
      type: "node_upsert",
      session_id: "s",
      node: mkNode({ _id: "n1" }),
    });
    useGraphStore.getState().applyGraphEvent({
      type: "node_enriched",
      session_id: "s",
      node_id: "n1",
      info: [{ text: "hello", created_at: "2024-01-01T00:00:00Z" }],
    });
    expect(useGraphStore.getState().nodes["n1"].info[0].text).toBe("hello");
  });
});
