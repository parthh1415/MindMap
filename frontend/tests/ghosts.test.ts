import { describe, it, expect, beforeEach, vi } from "vitest";
import { useGraphStore } from "../src/state/graphStore";
import { extractCandidates, processTranscriptPartial, __test__ } from "../src/lib/optimisticGhosts";

describe("optimistic ghosts", () => {
  beforeEach(() => {
    useGraphStore.getState().resetGraph();
    vi.useFakeTimers();
  });

  it("extracts capitalized noun-phrase candidates", () => {
    const cands = extractCandidates("We should review Speaker auth and idempotency keys");
    expect(cands.some((c) => c.toLowerCase().includes("speaker"))).toBe(true);
    expect(cands.some((c) => c.toLowerCase().includes("idempotency"))).toBe(true);
  });

  it("filters stoplist tokens", () => {
    const cands = extractCandidates("the of and a but it");
    expect(cands.length).toBe(0);
  });

  it("levenshtein matches near-duplicates", () => {
    expect(__test__.levenshtein("cache", "caches")).toBeLessThanOrEqual(1);
    expect(__test__.levenshtein("idempotent", "idempotency")).toBeLessThanOrEqual(2);
  });

  it("creates ghosts that auto-expire after 8 seconds", () => {
    processTranscriptPartial("Backpressure matters", "speaker-1");
    const ghosts1 = Object.values(useGraphStore.getState().ghostNodes);
    expect(ghosts1.length).toBeGreaterThan(0);

    vi.advanceTimersByTime(8_001);
    const ghosts2 = Object.values(useGraphStore.getState().ghostNodes);
    expect(ghosts2.length).toBe(0);
  });

  it("does not duplicate ghost when matching label already exists", () => {
    useGraphStore.getState().addGhost("Backpressure", "speaker-1");
    const before = Object.keys(useGraphStore.getState().ghostNodes).length;
    processTranscriptPartial("And about backpressure", "speaker-1");
    const after = Object.keys(useGraphStore.getState().ghostNodes).length;
    expect(after).toBe(before);
  });
});
