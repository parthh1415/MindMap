import { describe, it, expect } from "vitest";
import { computeLayout } from "@/ar/graph3d";

describe("computeLayout", () => {
  it("returns one position per node id", () => {
    const out = computeLayout(
      [{ _id: "a", label: "A" }, { _id: "b", label: "B" }, { _id: "c", label: "C" }],
      [{ source_id: "a", target_id: "b" }, { source_id: "b", target_id: "c" }],
    );
    expect(Object.keys(out).sort()).toEqual(["a", "b", "c"]);
  });

  it("normalizes positions so max radius is approximately TARGET_GRAPH_RADIUS", () => {
    const out = computeLayout(
      [{ _id: "a", label: "A" }, { _id: "b", label: "B" }],
      [{ source_id: "a", target_id: "b" }],
    );
    const radii = Object.values(out).map((p) => Math.hypot(p.x, p.y, p.z));
    const max = Math.max(...radii);
    expect(max).toBeGreaterThan(0.5);
    expect(max).toBeLessThanOrEqual(2.01); // TARGET_GRAPH_RADIUS = 2.0
  });

  it("centers the layout around origin", () => {
    const out = computeLayout(
      [{ _id: "a", label: "A" }, { _id: "b", label: "B" }, { _id: "c", label: "C" }],
      [{ source_id: "a", target_id: "b" }, { source_id: "b", target_id: "c" }],
    );
    const ps = Object.values(out);
    const cx = ps.reduce((s, p) => s + p.x, 0) / ps.length;
    const cy = ps.reduce((s, p) => s + p.y, 0) / ps.length;
    const cz = ps.reduce((s, p) => s + p.z, 0) / ps.length;
    expect(Math.abs(cx)).toBeLessThan(0.01);
    expect(Math.abs(cy)).toBeLessThan(0.01);
    expect(Math.abs(cz)).toBeLessThan(0.01);
  });

  // Regression: the underlying d3-force-3d throws "node not found: <id>"
  // on an edge whose endpoint is missing from the nodes list. ARStage
  // must filter these BEFORE calling computeLayout — these tests pin
  // the contract: feed only edges with valid endpoints, no throw; feed
  // an orphan edge directly, throw with the expected message.
  it("succeeds when called with the SAME nodes/edges shape ARStage produces (post-filter)", () => {
    expect(() =>
      computeLayout(
        [{ _id: "a", label: "A" }, { _id: "b", label: "B" }],
        [{ source_id: "a", target_id: "b" }],
      ),
    ).not.toThrow();
  });

  it("throws 'node not found: <id>' when an edge endpoint is missing — confirming the d3-force-3d contract that ARStage's filter relies on", () => {
    expect(() =>
      computeLayout(
        [{ _id: "a", label: "A" }],
        [{ source_id: "a", target_id: "ghost-id" }],
      ),
    ).toThrow(/node not found: ghost-id/);
  });
});
