// backendBridge.ts
//
// Forwards TranscriptChunk JSON to the MindMap backend's /ws/transcript
// endpoint. Reconnects with exponential backoff (1s, 2s, 4s, ..., capped at
// 10s). Buffers up to 100 chunks while disconnected and drops the oldest
// when the buffer is full.

import type { TranscriptChunk } from "../../shared/ws_messages";

export interface BackendBridgeOptions {
  url: string; // e.g. ws://localhost:8000/ws/transcript
  bufferSize?: number; // default 100
  initialBackoffMs?: number; // default 1000
  maxBackoffMs?: number; // default 10000
  // Hooks (mostly for diagnostics/UI surfacing).
  onOpen?: () => void;
  onClose?: (code: number, reason: string) => void;
  onError?: (err: unknown) => void;
}

export interface BackendBridgeHandle {
  connect: () => void;
  send: (chunk: TranscriptChunk) => void;
  close: () => void;
  isOpen: () => boolean;
  pendingCount: () => number;
}

export function createBackendBridge(
  opts: BackendBridgeOptions,
): BackendBridgeHandle {
  const bufferSize = opts.bufferSize ?? 100;
  const initialBackoff = opts.initialBackoffMs ?? 1000;
  const maxBackoff = opts.maxBackoffMs ?? 10000;

  let ws: WebSocket | null = null;
  let buffer: TranscriptChunk[] = [];
  let backoff = initialBackoff;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // True between connect() and close() — we should keep retrying.
  let alive = false;
  let connecting = false;

  const flush = () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    while (buffer.length > 0) {
      const next = buffer[0];
      try {
        ws.send(JSON.stringify(next));
        buffer.shift();
      } catch (e) {
        // If a send fails, stop draining; we'll retry on next open.
        opts.onError?.(e);
        return;
      }
    }
  };

  const scheduleReconnect = () => {
    if (!alive) return;
    if (reconnectTimer) return;
    const delay = backoff;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      doConnect();
    }, delay);
    backoff = Math.min(backoff * 2, maxBackoff);
  };

  const doConnect = () => {
    if (!alive || connecting) return;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    connecting = true;
    let socket: WebSocket;
    try {
      socket = new WebSocket(opts.url);
    } catch (e) {
      connecting = false;
      opts.onError?.(e);
      scheduleReconnect();
      return;
    }
    ws = socket;

    socket.addEventListener("open", () => {
      connecting = false;
      backoff = initialBackoff;
      opts.onOpen?.();
      flush();
    });
    socket.addEventListener("close", (ev) => {
      connecting = false;
      ws = null;
      opts.onClose?.(ev.code, ev.reason ?? "");
      scheduleReconnect();
    });
    socket.addEventListener("error", (ev) => {
      connecting = false;
      opts.onError?.(ev);
      // The close event will follow; reconnect is scheduled there.
    });
  };

  const connect = () => {
    if (alive) return;
    alive = true;
    backoff = initialBackoff;
    doConnect();
  };

  const send = (chunk: TranscriptChunk) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(chunk));
        return;
      } catch (e) {
        opts.onError?.(e);
        // fall through to buffering
      }
    }
    buffer.push(chunk);
    if (buffer.length > bufferSize) {
      // Drop oldest — keeping the most recent context is more useful for
      // a real-time mind map than ancient backlog.
      buffer.splice(0, buffer.length - bufferSize);
    }
  };

  const close = () => {
    alive = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      try {
        ws.close(1000, "client closing");
      } catch {
        /* noop */
      }
      ws = null;
    }
    buffer = [];
  };

  return {
    connect,
    send,
    close,
    isOpen: () => !!ws && ws.readyState === WebSocket.OPEN,
    pendingCount: () => buffer.length,
  };
}
