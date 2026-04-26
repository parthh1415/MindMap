// Tests for transcriptClient — fallback trigger logic.
// We mock WebSocket so the elevenLabsClient connects synchronously, then
// inject server-sent error messages and assert the fallback fires.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock micCapture: capturing audio in jsdom is not possible; we replace it
// with a no-op that just registers callbacks.
vi.mock("../client/micCapture", () => ({
  createMicCapture: () => ({
    start: async () => {
      /* noop */
    },
    stop: async () => {
      /* noop */
    },
    onAudioChunk: () => () => false,
    isRunning: () => true,
  }),
}));

// Mock webSpeechFallback so we don't need a real SpeechRecognition impl.
vi.mock("../client/webSpeechFallback", () => ({
  createWebSpeechFallback: () => ({
    start: () => {
      /* noop */
    },
    stop: () => {
      /* noop */
    },
    isActive: () => true,
    onChunk: () => () => false,
    onError: () => () => false,
    getSpeakerId: () => "speaker_fallback",
  }),
}));

// Reuse a minimal MockWebSocket like the elevenLabsClient test.
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = 0;
  binaryType: BinaryType = "arraybuffer";
  url: string;
  sent: Array<string | ArrayBuffer> = [];
  private listeners = {
    open: [] as Array<(ev: Event) => void>,
    close: [] as Array<(ev: CloseEvent) => void>,
    error: [] as Array<(ev: Event) => void>,
    message: [] as Array<(ev: MessageEvent) => void>,
  };

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }
  addEventListener(type: keyof typeof this.listeners, cb: (ev: Event) => void) {
    (this.listeners[type] as Array<(ev: Event) => void>).push(cb);
  }
  send(data: string | ArrayBuffer) {
    this.sent.push(data);
  }
  close(code = 1000, reason = "") {
    this.readyState = MockWebSocket.CLOSED;
    this.listeners.close.forEach((cb) =>
      cb({ code, reason } as unknown as CloseEvent),
    );
  }

  triggerOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.listeners.open.forEach((cb) => cb(new Event("open")));
  }
  triggerMessage(data: unknown) {
    const msg = typeof data === "string" ? data : JSON.stringify(data);
    this.listeners.message.forEach((cb) =>
      cb({ data: msg } as unknown as MessageEvent),
    );
  }
  triggerClose(code: number, reason: string) {
    this.readyState = MockWebSocket.CLOSED;
    this.listeners.close.forEach((cb) =>
      cb({ code, reason } as unknown as CloseEvent),
    );
  }
}

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.stubGlobal("WebSocket", MockWebSocket);
  // The pipeline now tries AssemblyAI FIRST, which kicks off a
  // /internal/assembly-token GET. Stub fetch to return 503 (server
  // not configured) so AssemblyAI fails fast and the chain falls
  // through to ElevenLabs — which is what these tests exercise.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response('{"detail":"ASSEMBLYAI_API_KEY not configured"}', {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("transcriptClient fallback triggers", () => {
  it("invokes onFallbackActivated with reason=credit on a credit error event", async () => {
    const { createTranscriptPipeline } = await import("../client/transcriptClient");
    const fallbackEvents: Array<{ reason: string; detail?: string }> = [];

    const pipeline = createTranscriptPipeline({
      sessionId: "sess_x",
      apiKey: "sk_test",
      onChunk: () => {
        /* noop */
      },
      onFallbackActivated: (reason, detail) => {
        fallbackEvents.push({ reason, detail });
      },
    });

    const startP = pipeline.start();
    // The pipeline first tries AssemblyAI (stubbed fetch → 503), then
    // falls through to ElevenLabs which creates the WebSocket. Wait a
    // few ticks for that chain to settle.
    for (let i = 0; i < 10 && MockWebSocket.instances.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    await startP;

    // Simulate a credit-exhaustion error from the server.
    ws.triggerMessage({
      type: "error",
      message: "Quota exceeded: insufficient credits",
    });

    // Allow microtasks to flush the swap.
    await new Promise((r) => setTimeout(r, 0));

    expect(fallbackEvents).toHaveLength(1);
    expect(fallbackEvents[0]!.reason).toBe("credit");
    expect(pipeline.isFallbackActive()).toBe(true);

    await pipeline.stop();
  });

  it("invokes onFallbackActivated with reason=manual when forceFallback is set at start", async () => {
    const { createTranscriptPipeline } = await import("../client/transcriptClient");
    const events: Array<{ reason: string }> = [];
    const pipeline = createTranscriptPipeline({
      sessionId: "sess_y",
      apiKey: "sk_test",
      forceFallback: true,
      onChunk: () => {
        /* noop */
      },
      onFallbackActivated: (reason) => events.push({ reason }),
    });
    await pipeline.start();
    expect(events[0]?.reason).toBe("manual");
    expect(pipeline.isFallbackActive()).toBe(true);
    await pipeline.stop();
  });

  it("invokes onFallbackActivated with reason=no-api-key when apiKey is missing", async () => {
    const { createTranscriptPipeline } = await import("../client/transcriptClient");
    const events: Array<{ reason: string }> = [];
    const pipeline = createTranscriptPipeline({
      sessionId: "sess_z",
      // intentionally no apiKey, and import.meta.env is undefined under jsdom
      onChunk: () => {
        /* noop */
      },
      onFallbackActivated: (reason) => events.push({ reason }),
    });
    await pipeline.start();
    expect(events[0]?.reason).toBe("no-api-key");
    await pipeline.stop();
  });
});
