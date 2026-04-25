// Tests for backendBridge — buffering, reconnect with exponential backoff,
// and chunk forwarding once the socket opens.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = 0;
  url: string;
  sent: string[] = [];
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
  send(data: string) {
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
  triggerClose(code = 1006, reason = "") {
    this.readyState = MockWebSocket.CLOSED;
    this.listeners.close.forEach((cb) =>
      cb({ code, reason } as unknown as CloseEvent),
    );
  }
}

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.stubGlobal("WebSocket", MockWebSocket);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const baseChunk = {
  type: "transcript" as const,
  session_id: "sess",
  speaker_id: "speaker_0",
  text: "hi",
  is_final: false,
  ts_client: 1,
};

describe("backendBridge", () => {
  it("buffers chunks before the socket opens, then flushes on open", async () => {
    const { createBackendBridge } = await import("../client/backendBridge");
    const bridge = createBackendBridge({ url: "ws://test/ws/transcript" });
    bridge.connect();
    bridge.send(baseChunk);
    bridge.send({ ...baseChunk, text: "two" });

    expect(bridge.pendingCount()).toBe(2);
    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();

    expect(ws.sent).toHaveLength(2);
    expect(JSON.parse(ws.sent[0]!).text).toBe("hi");
    expect(JSON.parse(ws.sent[1]!).text).toBe("two");
    expect(bridge.pendingCount()).toBe(0);

    bridge.close();
  });

  it("caps buffer at bufferSize and drops oldest entries", async () => {
    const { createBackendBridge } = await import("../client/backendBridge");
    const bridge = createBackendBridge({
      url: "ws://test/ws/transcript",
      bufferSize: 3,
    });
    bridge.connect();
    for (let i = 0; i < 10; i++) {
      bridge.send({ ...baseChunk, text: `n${i}` });
    }
    expect(bridge.pendingCount()).toBe(3);

    const ws = MockWebSocket.instances[0]!;
    ws.triggerOpen();
    expect(ws.sent.map((s) => JSON.parse(s).text)).toEqual(["n7", "n8", "n9"]);
    bridge.close();
  });

  it("reconnects with exponential backoff after a close", async () => {
    const { createBackendBridge } = await import("../client/backendBridge");
    const bridge = createBackendBridge({
      url: "ws://test/ws/transcript",
      initialBackoffMs: 1000,
      maxBackoffMs: 10000,
    });
    bridge.connect();
    expect(MockWebSocket.instances).toHaveLength(1);

    // First close → reconnect after 1s.
    MockWebSocket.instances[0]!.triggerClose(1006, "boom");
    expect(MockWebSocket.instances).toHaveLength(1); // still pending
    vi.advanceTimersByTime(1000);
    expect(MockWebSocket.instances).toHaveLength(2);

    // Second close (still failing) → backoff = 2s.
    MockWebSocket.instances[1]!.triggerClose(1006, "boom");
    vi.advanceTimersByTime(1999);
    expect(MockWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(3);

    // Third close → backoff = 4s.
    MockWebSocket.instances[2]!.triggerClose(1006, "boom");
    vi.advanceTimersByTime(3999);
    expect(MockWebSocket.instances).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(4);

    bridge.close();
  });

  it("does NOT reconnect after explicit close()", async () => {
    const { createBackendBridge } = await import("../client/backendBridge");
    const bridge = createBackendBridge({
      url: "ws://test/ws/transcript",
      initialBackoffMs: 100,
    });
    bridge.connect();
    bridge.close();
    vi.advanceTimersByTime(5000);
    // Only the initial socket — no reconnection.
    expect(MockWebSocket.instances).toHaveLength(1);
  });
});
