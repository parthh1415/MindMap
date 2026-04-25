// Verifies that diarization speaker_ids from Scribe v2 are passed through
// to TranscriptChunk.speaker_id verbatim — and that consecutive speakers
// switch correctly.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  readyState = 0;
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
  close() {
    this.readyState = MockWebSocket.CLOSED;
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
}

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.stubGlobal("WebSocket", MockWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("speaker_id pass-through from Scribe diarization", () => {
  it("preserves distinct speakers across multiple events", async () => {
    const { createElevenLabsClient } = await import(
      "../client/elevenLabsClient"
    );
    const client = createElevenLabsClient({
      apiKey: "sk_test",
      sessionId: "sessP",
    });
    const speakers: string[] = [];
    client.onChunk((c) => speakers.push(c.speaker_id));

    const p = client.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    await p;

    ws.triggerMessage({
      type: "partial_transcript",
      text: "alice talking",
      speaker_id: "speaker_0",
    });
    ws.triggerMessage({
      type: "partial_transcript",
      text: "bob talking",
      speaker_id: "speaker_1",
    });
    ws.triggerMessage({
      type: "committed_transcript",
      text: "alice finished",
      speaker_id: "speaker_0",
    });

    expect(speakers).toEqual(["speaker_0", "speaker_1", "speaker_0"]);
  });

  it("inherits the last seen speaker_id when an event omits it", async () => {
    const { createElevenLabsClient } = await import(
      "../client/elevenLabsClient"
    );
    const client = createElevenLabsClient({
      apiKey: "sk_test",
      sessionId: "sessP2",
    });
    const speakers: string[] = [];
    client.onChunk((c) => speakers.push(c.speaker_id));

    const p = client.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    await p;

    ws.triggerMessage({
      type: "partial_transcript",
      text: "first",
      speaker_id: "speaker_3",
    });
    ws.triggerMessage({
      type: "partial_transcript",
      text: "second",
      // no speaker_id — should inherit "speaker_3"
    });
    expect(speakers).toEqual(["speaker_3", "speaker_3"]);
  });
});
