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
});
