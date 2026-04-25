// Tests for elevenLabsClient — message parsing, speaker_id pass-through,
// and close-code classification (which feeds the fallback decision).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createElevenLabsClient,
  __test__,
} from "../client/elevenLabsClient";
import type { TranscriptChunk } from "../../shared/ws_messages";

// --- Minimal mock WebSocket ----------------------------------------------

interface MockListeners {
  open: Array<(ev: Event) => void>;
  close: Array<(ev: CloseEvent) => void>;
  error: Array<(ev: Event) => void>;
  message: Array<(ev: MessageEvent) => void>;
}

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
  private listeners: MockListeners = {
    open: [],
    close: [],
    error: [],
    message: [],
  };

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: keyof MockListeners, cb: (ev: Event) => void) {
    this.listeners[type].push(cb as never);
  }
  removeEventListener() {
    /* not used in these tests */
  }
  send(data: string | ArrayBuffer) {
    this.sent.push(data);
  }
  close(_code = 1000, _reason = "") {
    this.readyState = MockWebSocket.CLOSED;
    this.listeners.close.forEach((cb) =>
      cb({ code: _code, reason: _reason } as unknown as CloseEvent),
    );
  }

  // Test helpers
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
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("elevenLabsClient close-code classification", () => {
  it("flags 1008 with credit reason as credit", () => {
    expect(__test__.classifyClose(1008, "Quota exceeded")).toBe("credit");
  });
  it("flags 4002 as credit", () => {
    expect(__test__.classifyClose(4002, "")).toBe("credit");
  });
  it("flags 4001 as auth", () => {
    expect(__test__.classifyClose(4001, "")).toBe("auth");
  });
  it("flags 1008 with no reason as auth", () => {
    expect(__test__.classifyClose(1008, "")).toBe("auth");
  });
});

describe("elevenLabsClient message parsing", () => {
  it("emits a partial TranscriptChunk with speaker_id from diarization", async () => {
    const client = createElevenLabsClient({
      apiKey: "sk_test",
      sessionId: "sess_1",
    });
    const chunks: TranscriptChunk[] = [];
    client.onChunk((c) => chunks.push(c));

    const connectP = client.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    await connectP;

    ws.triggerMessage({
      type: "partial_transcript",
      text: "hello world",
      speaker_id: "speaker_1",
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      type: "transcript",
      session_id: "sess_1",
      speaker_id: "speaker_1",
      text: "hello world",
      is_final: false,
    });
    expect(typeof chunks[0]!.ts_client).toBe("number");
  });

  it("emits a final TranscriptChunk on committed events", async () => {
    const client = createElevenLabsClient({
      apiKey: "sk_test",
      sessionId: "sess_1",
    });
    const chunks: TranscriptChunk[] = [];
    client.onChunk((c) => chunks.push(c));

    const connectP = client.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    await connectP;

    ws.triggerMessage({
      type: "committed_transcript",
      text: "this is final",
      speaker: "speaker_0",
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.is_final).toBe(true);
    expect(chunks[0]!.speaker_id).toBe("speaker_0");
  });

  it("derives speaker_id from word-level diarization when top-level is missing", async () => {
    const client = createElevenLabsClient({
      apiKey: "sk_test",
      sessionId: "sess_2",
    });
    const chunks: TranscriptChunk[] = [];
    client.onChunk((c) => chunks.push(c));

    const connectP = client.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    await connectP;

    ws.triggerMessage({
      type: "transcript",
      text: "alpha beta gamma",
      is_final: true,
      words: [
        { text: "alpha", speaker_id: "speaker_2" },
        { text: "beta", speaker_id: "speaker_2" },
        { text: "gamma", speaker_id: "speaker_3" },
      ],
    });

    expect(chunks[0]!.speaker_id).toBe("speaker_2");
  });

  it("emits an error event with kind=credit when server sends a credit error", async () => {
    const client = createElevenLabsClient({
      apiKey: "sk_test",
      sessionId: "sess_3",
    });
    const errs: Array<{ kind: string }> = [];
    client.onError((e) => errs.push(e));

    const connectP = client.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    await connectP;

    ws.triggerMessage({
      type: "error",
      message: "Insufficient credits to continue session",
    });

    expect(errs).toHaveLength(1);
    expect(errs[0]!.kind).toBe("credit");
  });
});
