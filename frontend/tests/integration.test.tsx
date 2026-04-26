import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act } from "@testing-library/react";
import { useEffect } from "react";

import { useGraphStore } from "../src/state/graphStore";
import {
  processTranscriptPartial,
  extractCandidates,
} from "../src/lib/optimisticGhosts";

// ── Mock @mindmap/transcript-client so we can drive the pipeline without
// ── touching real WebSockets or the mic. The mock exposes a tiny harness
// ── that lets each test push synthetic chunks and assert the bridge sees
// ── them.
type AnyChunk = {
  type: "transcript";
  session_id: string;
  speaker_id: string;
  text: string;
  is_final: boolean;
  ts_client: number;
};

const mocks = {
  pushChunk: ((_c: AnyChunk) => {
    /* replaced when pipeline is created */
  }) as (c: AnyChunk) => void,
  bridgeSends: [] as AnyChunk[],
  bridgeOpened: false,
  bridgeClosed: false,
  pipelineStarted: false,
  pipelineStopped: false,
  triggerFallback: ((_reason: string, _detail?: string) => {
    /* replaced */
  }) as (reason: string, detail?: string) => void,
};

vi.mock("@mindmap/transcript-client", () => ({
  createTranscriptPipeline: (opts: {
    sessionId: string;
    onChunk: (c: AnyChunk) => void;
    onFallbackActivated?: (reason: string, detail?: string) => void;
  }) => {
    mocks.pushChunk = (c) => opts.onChunk(c);
    mocks.triggerFallback = (reason, detail) =>
      opts.onFallbackActivated?.(reason, detail);
    return {
      start: async () => {
        mocks.pipelineStarted = true;
      },
      stop: async () => {
        mocks.pipelineStopped = true;
      },
      isFallbackActive: () => false,
      forceFallback: async () => {},
    };
  },
  createBackendBridge: (_opts: { url: string }) => ({
    connect: () => {
      mocks.bridgeOpened = true;
    },
    send: (chunk: AnyChunk) => {
      mocks.bridgeSends.push(chunk);
    },
    close: () => {
      mocks.bridgeClosed = true;
    },
    isOpen: () => true,
    pendingCount: () => 0,
  }),
}));

// Mock sonner so toast() doesn't crash in jsdom.
vi.mock("sonner", () => ({
  toast: Object.assign(() => {}, {
    warning: () => {},
    error: () => {},
    success: () => {},
  }),
}));

// Import AFTER vi.mock so the mocked module is used.
import { useTranscriptPipeline } from "../src/integration/transcriptPipeline";

function Harness({
  sessionId,
  enabled,
}: {
  sessionId: string | null;
  enabled: boolean;
}) {
  useTranscriptPipeline({ sessionId, enabled });
  return null;
}

describe("frontend integration: transcript pipeline", () => {
  beforeEach(() => {
    useGraphStore.getState().resetGraph();
    mocks.bridgeSends = [];
    mocks.bridgeOpened = false;
    mocks.bridgeClosed = false;
    mocks.pipelineStarted = false;
    mocks.pipelineStopped = false;
  });

  it("starts the pipeline and bridge when enabled flips true", async () => {
    const { rerender } = render(
      <Harness sessionId="sess-1" enabled={false} />,
    );
    expect(mocks.pipelineStarted).toBe(false);

    rerender(<Harness sessionId="sess-1" enabled={true} />);
    // The effect spawns an async start(); flush microtasks.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.pipelineStarted).toBe(true);
    expect(mocks.bridgeOpened).toBe(true);
  });

  it("forwards chunks to the bridge and seeds ghosts on partials", async () => {
    render(<Harness sessionId="sess-1" enabled={true} />);
    await act(async () => {
      await Promise.resolve();
    });

    // partial chunk
    act(() => {
      mocks.pushChunk({
        type: "transcript",
        session_id: "sess-1",
        speaker_id: "speaker_0",
        text: "we need to think about cybersecurity threats and zero-trust authentication",
        is_final: false,
        ts_client: Date.now(),
      });
    });

    expect(mocks.bridgeSends.length).toBe(1);
    expect(mocks.bridgeSends[0].text).toContain("cybersecurity");

    // Ghost extractor should have produced at least one ghost.
    const ghosts = Object.values(useGraphStore.getState().ghostNodes);
    expect(ghosts.length).toBeGreaterThan(0);
  });

  it("seeds ghosts on FINAL chunks too — SWARM behavior", async () => {
    // Pre-SWARM, finals were authoritative-only and the client did not
    // seed ghosts on them. Post-SWARM, both partials AND finals seed
    // ghosts (with longer TTL on finals) so the canvas shows activity
    // even when the LLM topology agent is throttled.
    render(<Harness sessionId="sess-1" enabled={true} />);
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      mocks.pushChunk({
        type: "transcript",
        session_id: "sess-1",
        speaker_id: "speaker_0",
        text: "another distinctive phrase about replication lag",
        is_final: true,
        ts_client: Date.now(),
      });
    });

    expect(mocks.bridgeSends.length).toBe(1);
    expect(Object.keys(useGraphStore.getState().ghostNodes).length).toBeGreaterThan(0);
  });

  it("tears down pipeline + bridge on unmount", async () => {
    const { unmount } = render(<Harness sessionId="sess-1" enabled={true} />);
    await act(async () => {
      await Promise.resolve();
    });
    unmount();
    // teardown is async — flush the microtask queue.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.pipelineStopped).toBe(true);
    expect(mocks.bridgeClosed).toBe(true);
  });

  it("calls onFallback when the pipeline reports a fallback swap", async () => {
    const onFallback = vi.fn();
    function H() {
      // local wrapper to inject onFallback
      useEffect(() => {}, []);
      useTranscriptPipeline({
        sessionId: "sess-1",
        enabled: true,
        onFallback,
      });
      return null;
    }
    render(<H />);
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      mocks.triggerFallback("no-api-key", "missing key");
    });
    expect(onFallback).toHaveBeenCalledWith("no-api-key", "missing key");
  });
});

describe("frontend integration: ghost extractor wired into pipeline", () => {
  beforeEach(() => {
    useGraphStore.getState().resetGraph();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("extractCandidates rejects pure stoplist input", () => {
    expect(extractCandidates("the and of a but to")).toEqual([]);
  });

  it("ghosts auto-expire after 8 seconds", () => {
    processTranscriptPartial("we should consider Backpressure", "speaker_0");
    const ghosts1 = Object.values(useGraphStore.getState().ghostNodes);
    expect(ghosts1.length).toBeGreaterThan(0);
    vi.advanceTimersByTime(8_001);
    const ghosts2 = Object.values(useGraphStore.getState().ghostNodes);
    expect(ghosts2.length).toBe(0);
  });

  it("does not re-add a ghost for an already-tracked phrase", () => {
    useGraphStore.getState().addGhost("Backpressure", "speaker_0");
    const before = Object.keys(useGraphStore.getState().ghostNodes).length;
    processTranscriptPartial("backpressure", "speaker_0");
    const after = Object.keys(useGraphStore.getState().ghostNodes).length;
    expect(after).toBe(before);
  });
});
