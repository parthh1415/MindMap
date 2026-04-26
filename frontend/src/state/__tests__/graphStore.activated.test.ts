import { describe, it, expect, beforeEach } from "vitest";
import { useGraphStore } from "@/state/graphStore";

describe("graphStore activated set", () => {
  beforeEach(() => {
    useGraphStore.setState({ activatedNodeIds: new Set() });
  });

  it("starts empty", () => {
    expect(useGraphStore.getState().activatedNodeIds.size).toBe(0);
  });

  it("toggleActivated adds id when absent", () => {
    useGraphStore.getState().toggleActivated("n1");
    expect(useGraphStore.getState().activatedNodeIds.has("n1")).toBe(true);
  });

  it("toggleActivated removes id when present", () => {
    useGraphStore.getState().toggleActivated("n1");
    useGraphStore.getState().toggleActivated("n1");
    expect(useGraphStore.getState().activatedNodeIds.has("n1")).toBe(false);
  });

  it("returns a NEW Set on toggle (referential change for React)", () => {
    const before = useGraphStore.getState().activatedNodeIds;
    useGraphStore.getState().toggleActivated("n1");
    const after = useGraphStore.getState().activatedNodeIds;
    expect(after).not.toBe(before);
  });
});
