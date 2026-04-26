import { toast } from "sonner";
import type { GraphEvent } from "@shared/ws_messages";
import { useGraphStore } from "@/state/graphStore";

/**
 * Single client-side WebSocket connection to the backend graph stream.
 *
 * Endpoint: `${VITE_BACKEND_WS_URL}/ws/graph/{sessionId}`
 *
 * On every received `GraphEvent`, we dispatch into the graph store. The
 * connection auto-reconnects with exponential backoff and surfaces
 * disconnect events through Sonner toasts (styled via project tokens — see
 * globals.css `[data-sonner-toaster]` overrides).
 */
export class GraphSocketClient {
  private ws: WebSocket | null = null;
  private url: string;
  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;
  private intentionallyClosed = false;

  constructor(sessionId: string) {
    const base = import.meta.env.VITE_BACKEND_WS_URL ?? "ws://localhost:8000";
    this.url = `${base.replace(/\/$/, "")}/ws/graph/${sessionId}`;
  }

  connect(): void {
    this.intentionallyClosed = false;
    this.openSocket();
  }

  close(): void {
    this.intentionallyClosed = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  private openSocket(): void {
    try {
      this.ws = new WebSocket(this.url);
    } catch (err) {
      console.error("[graph-ws] failed to construct WebSocket", err);
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
    };

    this.ws.onmessage = (ev) => {
      let parsed: GraphEvent;
      try {
        parsed = JSON.parse(ev.data) as GraphEvent;
      } catch (err) {
        console.warn("[graph-ws] non-JSON message", err);
        return;
      }
      if (typeof parsed.type !== "string") return;
      useGraphStore.getState().applyGraphEvent(parsed);
    };

    this.ws.onerror = () => {
      // onclose will fire and trigger reconnect; nothing to do here.
    };

    this.ws.onclose = () => {
      if (this.intentionallyClosed) return;
      toast("Connection lost — retrying…", {
        description: `attempt ${this.reconnectAttempts + 1}`,
      });
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    const delay = Math.min(15_000, 500 * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.reconnectTimer = window.setTimeout(() => this.openSocket(), delay);
  }
}
