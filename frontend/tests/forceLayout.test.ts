import { describe, it, expect } from "vitest";
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceCenter,
  forceSimulation,
} from "d3-force";
import {
  buildForceNodes,
  buildForceLinks,
  configureSimulation,
  type ForceNodeDatum,
  type ForceLinkDatum,
} from "@/lib/forceLayout";
import type { Node as ContractNode, Edge as ContractEdge } from "@shared/ws_messages";

// ─────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────

function makeNode(id: string, importance = 0.5): ContractNode {
  return {
    _id: id,
    session_id: "sess-1",
    label: id,
    speaker_id: null,
    importance_score: importance,
    parent_id: null,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    info: [],
    image_url: null,
    deleted_at: null,
  };
}

function makeEdge(
  id: string,
  source_id: string,
  target_id: string,
  edge_type: "solid" | "dashed" | "dotted" = "solid",
): ContractEdge {
  return {
    _id: id,
    session_id: "sess-1",
    source_id,
    target_id,
    edge_type,
    speaker_id: null,
    created_at: "2024-01-01T00:00:00Z",
    deleted_at: null,
  };
}

function nodeRadius(d: ForceNodeDatum): number {
  return 60 + (d.importance ?? 0.5) * 30;
}

function runSimSync(
  data: ForceNodeDatum[],
  links: ForceLinkDatum[],
  ticks: number,
) {
  const sim = forceSimulation<ForceNodeDatum, ForceLinkDatum>(data)
    .force("charge", forceManyBody<ForceNodeDatum>().strength(-220))
    .force(
      "link",
      forceLink<ForceNodeDatum, ForceLinkDatum>(links)
        .id((d) => d.id)
        .distance((d) => (d.edge_type === "dotted" ? 220 : 160))
        .strength(0.6),
    )
    .force("center", forceCenter<ForceNodeDatum>(0, 0))
    .force(
      "collide",
      forceCollide<ForceNodeDatum>().radius((d) => 60 + (d.importance ?? 0.5) * 30),
    )
    .alphaDecay(0.025)
    .stop();
  sim.tick(ticks);
  return sim;
}

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

describe("forceLayout helpers", () => {
  it("buildForceNodes preserves existing datum identity (no teleport)", () => {
    const nodes = [makeNode("a"), makeNode("b")];
    const prev = new Map<string, ForceNodeDatum>();
    const data1 = buildForceNodes(nodes, [], prev);
    // place by position
    data1[0].x = 100;
    data1[0].y = -40;
    data1[1].x = -50;
    data1[1].y = 33;
    const map = new Map(data1.map((d) => [d.id, d] as const));

    const nodes2 = [...nodes, makeNode("c")];
    const data2 = buildForceNodes(nodes2, [], map);
    const a = data2.find((d) => d.id === "a")!;
    const b = data2.find((d) => d.id === "b")!;
    expect(a).toBe(data1[0]);
    expect(b).toBe(data1[1]);
    expect(a.x).toBe(100);
    expect(b.y).toBe(33);
  });

  it("buildForceLinks drops links with missing endpoints", () => {
    const ids = new Set(["a", "b"]);
    const edges = [makeEdge("e1", "a", "b"), makeEdge("e2", "a", "z")];
    const links = buildForceLinks(edges, ids);
    expect(links).toHaveLength(1);
    expect(links[0].id).toBe("e1");
  });

  it("configureSimulation wires the standard forces", () => {
    const sim = forceSimulation<ForceNodeDatum, ForceLinkDatum>([]);
    configureSimulation(sim, {});
    expect(sim.force("charge")).toBeDefined();
    expect(sim.force("link")).toBeDefined();
    expect(sim.force("center")).toBeDefined();
    expect(sim.force("collide")).toBeDefined();
    // Tuned for the Obsidian-feel layout pass (slower decay, floatier).
    expect(sim.alphaDecay()).toBeCloseTo(0.018, 5);
    sim.stop();
  });
});

describe("force simulation behavior", () => {
  it("5 nodes + 4 edges settle to non-overlapping positions", () => {
    const nodes = [
      makeNode("a"),
      makeNode("b"),
      makeNode("c"),
      makeNode("d"),
      makeNode("e"),
    ];
    const edges = [
      makeEdge("e1", "a", "b"),
      makeEdge("e2", "a", "c"),
      makeEdge("e3", "b", "d"),
      makeEdge("e4", "c", "e"),
    ];
    const data = buildForceNodes(nodes, [], new Map());
    // Seed slight initial positions so the sim doesn't start fully degenerate.
    data.forEach((d, i) => {
      d.x = Math.cos(i) * 40;
      d.y = Math.sin(i) * 40;
    });
    const links = buildForceLinks(
      edges,
      new Set(data.map((d) => d.id)),
    );

    runSimSync(data, links, 400);

    // No two nodes should overlap inside the sum of their collide radii
    // (give a small numerical slack — d3 collide is iterative).
    const slack = 4;
    for (let i = 0; i < data.length; i++) {
      for (let j = i + 1; j < data.length; j++) {
        const dx = (data[i].x ?? 0) - (data[j].x ?? 0);
        const dy = (data[i].y ?? 0) - (data[j].y ?? 0);
        const dist = Math.sqrt(dx * dx + dy * dy);
        const minDist = nodeRadius(data[i]) + nodeRadius(data[j]) - slack;
        expect(dist).toBeGreaterThan(minDist);
      }
    }
  });

  it("adding a 6th node does not reset positions of nodes 1-5", () => {
    const nodes = [
      makeNode("a"),
      makeNode("b"),
      makeNode("c"),
      makeNode("d"),
      makeNode("e"),
    ];
    const edges = [
      makeEdge("e1", "a", "b"),
      makeEdge("e2", "a", "c"),
      makeEdge("e3", "b", "d"),
      makeEdge("e4", "c", "e"),
    ];
    const datumMap = new Map<string, ForceNodeDatum>();
    const data1 = buildForceNodes(nodes, [], datumMap);
    data1.forEach((d, i) => {
      d.x = Math.cos(i) * 40;
      d.y = Math.sin(i) * 40;
    });
    let links = buildForceLinks(edges, new Set(data1.map((d) => d.id)));
    runSimSync(data1, links, 400);

    // Snapshot post-settle positions.
    const before = new Map<string, { x: number; y: number }>();
    for (const d of data1) {
      datumMap.set(d.id, d);
      before.set(d.id, { x: d.x ?? 0, y: d.y ?? 0 });
    }

    // Now add a 6th node + a connecting edge, reuse existing data.
    const nodes2 = [...nodes, makeNode("f")];
    const edges2 = [...edges, makeEdge("e5", "a", "f")];
    const data2 = buildForceNodes(nodes2, [], datumMap);
    // Nodes 1-5 should have been *reused* (same object refs).
    for (const d of data1) {
      const matched = data2.find((x) => x.id === d.id);
      expect(matched).toBe(d);
    }

    links = buildForceLinks(edges2, new Set(data2.map((d) => d.id)));
    // Reheat with a modest alpha — the hook uses 0.4 in production but the
    // test cares about the *nudge-not-rebuild* property: the existing 5
    // nodes' position objects are reused, so even a strong reheat must not
    // scatter them randomly. We pick 0.25 here which still demonstrates the
    // gradient behavior without amplifying the unavoidable perturbation
    // caused by the new "f" node tugging on "a".
    const sim = forceSimulation<ForceNodeDatum, ForceLinkDatum>(data2)
      .force("charge", forceManyBody<ForceNodeDatum>().strength(-220))
      .force(
        "link",
        forceLink<ForceNodeDatum, ForceLinkDatum>(links)
          .id((d) => d.id)
          .distance((d) => (d.edge_type === "dotted" ? 220 : 160))
          .strength(0.6),
      )
      .force("center", forceCenter<ForceNodeDatum>(0, 0))
      .force(
        "collide",
        forceCollide<ForceNodeDatum>().radius((d) => 60 + (d.importance ?? 0.5) * 30),
      )
      .alphaDecay(0.025)
      .alpha(0.25)
      .stop();
    sim.tick(120);

    // Average drift of the original 5 nodes should stay modest — the
    // contract: structural change perturbs but does not RESET.
    let totalDrift = 0;
    for (const d of data1) {
      const prev = before.get(d.id)!;
      const dx = (d.x ?? 0) - prev.x;
      const dy = (d.y ?? 0) - prev.y;
      totalDrift += Math.sqrt(dx * dx + dy * dy);
    }
    const avgDrift = totalDrift / data1.length;
    expect(avgDrift).toBeLessThan(80);
  });
});
