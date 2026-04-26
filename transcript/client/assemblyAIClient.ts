// assemblyAIClient.ts
//
// Streams 16-bit PCM @ 16 kHz mono to AssemblyAI's Universal-Streaming v3
// WebSocket and emits TranscriptChunk events matching shared/ws_messages.ts.
//
// Auth flow (browser-safe):
//   1. Frontend GETs ${VITE_BACKEND_URL}/internal/assembly-token. Backend
//      proxies the request using the server-side ASSEMBLYAI_API_KEY (NEVER
//      exposed to the browser).
//   2. Frontend opens
//        wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&token=<temp>
//      (plus format_turns=true for richer per-word + diarization metadata).
//   3. Frontend pumps raw PCM 16-bit LE 16 kHz mono as binary WS frames.
//   4. AssemblyAI streams back JSON messages:
//        { type: "Begin", id, expires_at }
//        { type: "Turn",  transcript, end_of_turn, words: [{word, start, end, confidence, speaker?}], turn_order, ... }
//        { type: "Termination", ... }
//
// Diarization: each word in a Turn carries an optional `speaker` label
// (e.g. "A", "B"). We pick the dominant speaker per turn and pass it
// through as `speaker_id` so the existing speaker-color system keeps
// working unchanged.
//
// Endpoint override: pass `endpointUrl` to swap WS URLs without
// touching callers (mirrors elevenLabsClient.ts).

import type { TranscriptChunk } from "../../shared/ws_messages";

export type ChunkCallback = (chunk: TranscriptChunk) => void;
export type ErrorCallback = (err: AssemblyAIError) => void;
export type StateCallback = (state: AssemblyAIState) => void;

export type AssemblyAIState =
  | "idle"
  | "minting-token"
  | "connecting"
  | "open"
  | "closing"
  | "closed"
  | "error";

export interface AssemblyAIError {
  kind:
    | "auth"           // bad/expired token, account problem
    | "credit"         // out of credits
    | "network"        // can't reach AssemblyAI / token endpoint
    | "protocol"       // unparseable message
    | "transcribe"     // STT error
    | "unknown";
  message: string;
  code?: number;
  raw?: unknown;
}

export interface AssemblyAIClientOptions {
  /** URL of the backend's token-mint endpoint, e.g.
   *  "http://localhost:8000/internal/assembly-token". */
  tokenUrl: string;
  sessionId: string;
  /** Override the WS URL — handy for testing / docs drift. */
  endpointUrl?: string;
  /** Defaults to 16000 — must match what micCapture emits. */
  sampleRate?: number;
  /** Defaults to true — gives per-word + diarization metadata. */
  formatTurns?: boolean;
}

export interface AssemblyAIClient {
  connect: () => Promise<void>;
  sendAudio: (pcm16: Int16Array) => void;
  close: (code?: number, reason?: string) => Promise<void>;
  onChunk: (cb: ChunkCallback) => () => void;
  onError: (cb: ErrorCallback) => () => void;
  onState: (cb: StateCallback) => () => void;
  getState: () => AssemblyAIState;
}

const DEFAULT_ENDPOINT = "wss://streaming.assemblyai.com/v3/ws";

// Close codes (subset of ones AssemblyAI uses + generics we handle):
//   1008 policy violation — auth / credit denials
//   4001 custom: auth failure
//   4002 custom: insufficient credits
const CLOSE_AUTH_CODES = new Set([4001, 4003]);
const CLOSE_CREDIT_CODES = new Set([4002, 4029]);

function classifyClose(code: number, reason: string): AssemblyAIError["kind"] {
  const r = reason.toLowerCase();
  if (CLOSE_AUTH_CODES.has(code) || /unauth|invalid.+token|forbidden/.test(r)) {
    return "auth";
  }
  if (
    CLOSE_CREDIT_CODES.has(code) ||
    /credit|quota|limit|insufficient|payment/.test(r)
  ) {
    return "credit";
  }
  if (code === 1006 || code === 1011) return "network";
  return "unknown";
}

/**
 * Pick the dominant speaker label across the words of a turn. AssemblyAI
 * v3 emits `speaker` per word; falls back to `speaker_default` when no
 * diarization signal is present (e.g. single-speaker mode).
 */
export function dominantSpeakerOfTurn(
  words: Array<{ speaker?: string | number | null }> | undefined,
): string {
  if (!words || words.length === 0) return "speaker_default";
  const tally = new Map<string, number>();
  for (const w of words) {
    const s = w.speaker;
    if (s === null || s === undefined) continue;
    const key = typeof s === "number" ? `speaker_${s}` : `speaker_${String(s)}`;
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  if (tally.size === 0) return "speaker_default";
  let best = "speaker_default";
  let bestCount = -1;
  for (const [k, v] of tally) {
    if (v > bestCount) {
      best = k;
      bestCount = v;
    }
  }
  return best;
}

/**
 * Parse one server message (already JSON.parsed) into a TranscriptChunk
 * if it represents transcription content. Returns null for keep-alives
 * / Begin / Termination messages.
 */
export function parseAssemblyMessage(
  raw: unknown,
  sessionId: string,
): TranscriptChunk | null {
  if (!raw || typeof raw !== "object") return null;
  const msg = raw as Record<string, unknown>;
  const type = String(msg.type ?? "");

  // The Universal-Streaming v3 "Turn" message is the carrier of
  // transcripts. `end_of_turn === false` → partial; true → final.
  // (The legacy /v2/realtime API used `PartialTranscript` /
  // `FinalTranscript`. We accept those too for forward/back compat.)
  if (
    type === "Turn" ||
    type === "PartialTranscript" ||
    type === "FinalTranscript"
  ) {
    const text = String(msg.transcript ?? msg.text ?? "").trim();
    if (!text) return null;
    const isFinal =
      type === "FinalTranscript" ||
      msg.end_of_turn === true ||
      msg.message_type === "FinalTranscript";
    const words = (msg.words ?? msg.tokens ?? []) as Array<{
      speaker?: string | number | null;
    }>;
    return {
      type: "transcript",
      session_id: sessionId,
      speaker_id: dominantSpeakerOfTurn(words),
      text,
      is_final: !!isFinal,
      ts_client: Date.now(),
    };
  }

  return null;
}

interface InternalState {
  socket: WebSocket | null;
  state: AssemblyAIState;
  chunkSubs: Set<ChunkCallback>;
  errorSubs: Set<ErrorCallback>;
  stateSubs: Set<StateCallback>;
}

export function createAssemblyAIClient(
  opts: AssemblyAIClientOptions,
): AssemblyAIClient {
  const sampleRate = opts.sampleRate ?? 16000;
  const formatTurns = opts.formatTurns ?? true;
  const endpoint = opts.endpointUrl ?? DEFAULT_ENDPOINT;
  const tokenUrl = opts.tokenUrl;
  const sessionId = opts.sessionId;

  const internal: InternalState = {
    socket: null,
    state: "idle",
    chunkSubs: new Set(),
    errorSubs: new Set(),
    stateSubs: new Set(),
  };

  const setState = (s: AssemblyAIState) => {
    internal.state = s;
    for (const cb of internal.stateSubs) {
      try {
        cb(s);
      } catch {
        /* swallow */
      }
    }
  };

  const emitError = (err: AssemblyAIError) => {
    for (const cb of internal.errorSubs) {
      try {
        cb(err);
      } catch {
        /* swallow */
      }
    }
  };

  const emitChunk = (chunk: TranscriptChunk) => {
    for (const cb of internal.chunkSubs) {
      try {
        cb(chunk);
      } catch {
        /* swallow */
      }
    }
  };

  const mintToken = async (): Promise<string> => {
    setState("minting-token");
    const res = await fetch(tokenUrl, { method: "GET" });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw {
        kind: res.status === 503 ? "auth" : "network",
        message: `token mint HTTP ${res.status}: ${body.slice(0, 200)}`,
        code: res.status,
      } as AssemblyAIError;
    }
    const data = (await res.json()) as { token?: string };
    if (!data.token) {
      throw {
        kind: "protocol",
        message: "token-mint response missing `token`",
        raw: data,
      } as AssemblyAIError;
    }
    return data.token;
  };

  const connect = async (): Promise<void> => {
    if (
      internal.state === "open" ||
      internal.state === "connecting" ||
      internal.state === "minting-token"
    ) {
      return;
    }
    let token: string;
    try {
      token = await mintToken();
    } catch (err) {
      const aiErr = err as AssemblyAIError;
      setState("error");
      emitError(aiErr);
      throw aiErr;
    }

    const url = new URL(endpoint);
    url.searchParams.set("sample_rate", String(sampleRate));
    if (formatTurns) url.searchParams.set("format_turns", "true");
    url.searchParams.set("token", token);

    setState("connecting");
    const ws = new WebSocket(url.toString());
    ws.binaryType = "arraybuffer";
    internal.socket = ws;

    return new Promise<void>((resolve, reject) => {
      let opened = false;

      ws.addEventListener("open", () => {
        opened = true;
        setState("open");
        resolve();
      });

      ws.addEventListener("message", (ev: MessageEvent<unknown>) => {
        if (typeof ev.data !== "string") return; // ignore binary echoes (rare)
        let parsed: unknown;
        try {
          parsed = JSON.parse(ev.data);
        } catch (e) {
          emitError({
            kind: "protocol",
            message: `unparseable WS message: ${(e as Error).message}`,
            raw: ev.data,
          });
          return;
        }
        const chunk = parseAssemblyMessage(parsed, sessionId);
        if (chunk) emitChunk(chunk);
      });

      ws.addEventListener("error", () => {
        if (!opened) {
          const err: AssemblyAIError = {
            kind: "network",
            message: "WebSocket failed to open",
          };
          setState("error");
          emitError(err);
          reject(err);
        } else {
          emitError({
            kind: "network",
            message: "WebSocket error after open",
          });
        }
      });

      ws.addEventListener("close", (ev: CloseEvent) => {
        const code = ev.code;
        const reason = ev.reason ?? "";
        const kind = classifyClose(code, reason);
        if (internal.state !== "closing") {
          // Unexpected close — surface as error for the orchestrator
          // to decide on fallback.
          emitError({
            kind,
            message: `WS closed (${code}) ${reason || "no reason"}`.trim(),
            code,
          });
        }
        setState("closed");
        internal.socket = null;
        if (!opened) {
          reject({
            kind,
            message: `WebSocket failed to open (close ${code})`,
            code,
          } as AssemblyAIError);
        }
      });
    });
  };

  const sendAudio = (pcm16: Int16Array): void => {
    const ws = internal.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // AssemblyAI Universal-Streaming v3 expects raw PCM frames as the
    // BINARY WS payload. No JSON envelope, no base64.
    ws.send(pcm16.buffer.slice(pcm16.byteOffset, pcm16.byteOffset + pcm16.byteLength));
  };

  const close = async (code = 1000, reason = "client closed"): Promise<void> => {
    setState("closing");
    const ws = internal.socket;
    if (!ws) {
      setState("closed");
      return;
    }
    try {
      // v3 supports a `Terminate` JSON message to gracefully end a session
      // and flush any pending transcripts.
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "Terminate" }));
      }
    } catch {
      /* ignore */
    }
    try {
      ws.close(code, reason);
    } catch {
      /* ignore */
    }
    internal.socket = null;
    setState("closed");
  };

  const subscribe = <T>(set: Set<T>, cb: T): (() => void) => {
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  };

  return {
    connect,
    sendAudio,
    close,
    onChunk: (cb) => subscribe(internal.chunkSubs, cb),
    onError: (cb) => subscribe(internal.errorSubs, cb),
    onState: (cb) => subscribe(internal.stateSubs, cb),
    getState: () => internal.state,
  };
}

// Test seam — exposes pure parsers so we can test message parsing without
// a real WebSocket.
export const __test__ = {
  parseAssemblyMessage,
  dominantSpeakerOfTurn,
  classifyClose,
  DEFAULT_ENDPOINT,
};
