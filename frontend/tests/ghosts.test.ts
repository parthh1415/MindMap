import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useGraphStore } from "../src/state/graphStore";
import {
  extractCandidates,
  processTranscriptFinal,
  processTranscriptPartial,
  __test__,
} from "../src/lib/optimisticGhosts";

describe("optimistic ghosts", () => {
  beforeEach(() => {
    useGraphStore.getState().resetGraph();
    __test__.clearAll();
    __test__.resetThrottleState();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("extracts capitalized noun-phrase candidates", () => {
    const cands = extractCandidates(
      "We should review Speaker auth and idempotency keys",
    );
    expect(cands.some((c) => c.toLowerCase().includes("speaker"))).toBe(true);
    expect(cands.some((c) => c.toLowerCase().includes("idempotency"))).toBe(
      true,
    );
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

  // ───────────────────────────── SWARM additions ─────────────────────

  it("produces ≥3 candidates from a 15-word technical sentence (swarm density)", () => {
    const cands = extractCandidates(
      "we should design an api gateway with rate limiting and cache auth tokens in redis",
    );
    expect(cands.length).toBeGreaterThanOrEqual(3);
    // Should not exceed the per-call cap.
    expect(cands.length).toBeLessThanOrEqual(6);
  });

  it("seeds multiple ghosts from a single partial transcript", () => {
    processTranscriptPartial(
      "we should design an api gateway with rate limiting and cache auth tokens in redis",
      "speaker-1",
    );
    const ghosts = Object.values(useGraphStore.getState().ghostNodes);
    expect(ghosts.length).toBeGreaterThanOrEqual(3);
  });

  it("creates predictive edges between ghosts from same speaker within 4s", () => {
    processTranscriptPartial("api gateway", "speaker-1");
    // Advance 1 second — well within the 4 s window.
    vi.advanceTimersByTime(1_000);
    processTranscriptPartial("rate limiting", "speaker-1");

    const predictive = Object.values(
      useGraphStore.getState().predictiveEdges,
    );
    expect(predictive.length).toBeGreaterThanOrEqual(1);
  });

  it("caps predictive edges at 8 in-flight", () => {
    // Spew many distinct phrases for the same speaker quickly.
    const phrases = [
      "alpha node",
      "beta node",
      "gamma node",
      "delta node",
      "epsilon node",
      "zeta node",
      "eta node",
      "theta node",
      "iota node",
      "kappa node",
      "lambda node",
      "mu node",
    ];
    for (const p of phrases) {
      processTranscriptPartial(p, "speaker-1");
      vi.advanceTimersByTime(100);
    }
    const predictive = Object.values(
      useGraphStore.getState().predictiveEdges,
    );
    expect(predictive.length).toBeLessThanOrEqual(8);
  });

  it("bumps ghost TTL to 60s when LLM is throttled (no node arrivals for 26s)", () => {
    // Simulate "no node arrivals for 26 s".
    __test__.setLastNodeArrivalTs(Date.now() - 26_000);
    expect(__test__.isThrottled()).toBe(true);
    expect(__test__.currentPartialTtl()).toBe(
      __test__.constants.GHOST_TTL_THROTTLED_MS,
    );

    processTranscriptPartial("Backpressure matters here", "speaker-1");
    const before = Object.keys(useGraphStore.getState().ghostNodes).length;
    expect(before).toBeGreaterThan(0);

    // After 8 s — normal TTL — ghosts should still be present (because
    // throttled TTL is 60 s).
    vi.advanceTimersByTime(8_500);
    const mid = Object.keys(useGraphStore.getState().ghostNodes).length;
    expect(mid).toBe(before);

    // After 60 s total they expire.
    vi.advanceTimersByTime(52_000);
    const after = Object.keys(useGraphStore.getState().ghostNodes).length;
    expect(after).toBe(0);
  });

  it("processTranscriptFinal seeds ghosts with a 30s TTL", () => {
    processTranscriptFinal("Distributed Tracing", "speaker-1");
    const ghosts1 = Object.keys(useGraphStore.getState().ghostNodes);
    expect(ghosts1.length).toBeGreaterThan(0);

    // Past the normal 8 s partial TTL — finals should still be alive.
    vi.advanceTimersByTime(10_000);
    const stillThere = Object.keys(useGraphStore.getState().ghostNodes);
    expect(stillThere.length).toBe(ghosts1.length);

    // Past the 30 s final TTL — gone.
    vi.advanceTimersByTime(21_000);
    const gone = Object.keys(useGraphStore.getState().ghostNodes);
    expect(gone.length).toBe(0);
  });

  it("pushes speaker trail entries when ghosts are created", () => {
    processTranscriptPartial("api gateway and rate limiting", "speaker-1");
    const trail = useGraphStore.getState().speakerTrails["speaker-1"] ?? [];
    expect(trail.length).toBeGreaterThan(0);
    expect(trail[0]?.speaker_id).toBe("speaker-1");
  });
});
