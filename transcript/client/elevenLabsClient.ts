// elevenLabsClient.ts
//
// Streams 16-bit PCM @ 16 kHz to ElevenLabs Scribe v2 realtime over WebSocket
// and emits TranscriptChunk events matching shared/ws_messages.ts.
//
// IMPORTANT — endpoint assumption
// ===============================
// As of writing, ElevenLabs documents its realtime STT under
//   wss://api.elevenlabs.io/v1/speech-to-text/stream
// (the Scribe streaming endpoint). The brief mentions
//   wss://api.elevenlabs.io/v1/speech-to-text/realtime
// as a possibility. We default to the documented `/stream` path with the
// `model_id=scribe_v2` query param + `xi-api-key` header (sent via the
// browser-supported `Sec-WebSocket-Protocol` subprotocol trick OR via a
// query param fallback, since browsers can't set arbitrary WS headers).
//
// The endpoint is overridable via `endpointUrl` so we can flip it when
// the actual production URL is confirmed without touching consumers.
// See transcript/docs/README.md for details.

import type { TranscriptChunk } from "../../shared/ws_messages";

export type ChunkCallback = (chunk: TranscriptChunk) => void;
export type ErrorCallback = (err: ElevenLabsError) => void;
export type StateCallback = (state: ElevenLabsState) => void;

export type ElevenLabsState =
  | "idle"
  | "connecting"
  | "open"
  | "closing"
  | "closed"
  | "error";

export interface ElevenLabsError {
  kind:
    | "auth"
    | "credit"
    | "network"
    | "protocol"
    | "transcribe"
    | "unknown";
  message: string;
  code?: number;
  raw?: unknown;
}

export interface ElevenLabsClientOptions {
  apiKey: string;
  sessionId: string;
  endpointUrl?: string; // override the default WS URL
  modelId?: string; // default "scribe_v2"
  diarize?: boolean; // default true
  language?: string; // optional BCP-47, e.g. "en"
  sampleRate?: number; // default 16000
  // VAD-driven commit boundaries on the server. Scribe supports "vad" or
  // "manual"; we use vad for hands-off segmentation.
  commitStrategy?: "vad" | "manual";
}

export interface ElevenLabsClient {
  connect: () => Promise<void>;
  sendAudio: (pcm16: Int16Array) => void;
  commit: () => void; // manual commit (only useful when commitStrategy = "manual")
  close: (code?: number, reason?: string) => Promise<void>;
  onChunk: (cb: ChunkCallback) => () => void;
  onError: (cb: ErrorCallback) => () => void;
  onState: (cb: StateCallback) => () => void;
  getState: () => ElevenLabsState;
}

const DEFAULT_ENDPOINT = "wss://api.elevenlabs.io/v1/speech-to-text/stream";

// WebSocket close codes ElevenLabs uses (and generic ones we handle):
//   1008  policy violation — frequently used for auth/credit denials
//   4001  custom: auth failure (non-standard but seen in practice)
//   4002  custom: insufficient credits (non-standard but seen in practice)
const CLOSE_AUTH_CODES = new Set([4001, 4003]);
const CLOSE_CREDIT_CODES = new Set([4002, 4029]);

function classifyClose(code: number, reason: string): ElevenLabsError["kind"] {
  const r = reason.toLowerCase();
  if (CLOSE_AUTH_CODES.has(code) || /unauth|invalid.+key|forbidden/.test(r)) {
    return "auth";
  }
  if (
    CLOSE_CREDIT_CODES.has(code) ||
    /credit|quota|limit|insufficient|payment/.test(r)
  ) {
    return "credit";
  }
  if (code === 1008) {
    // 1008 = policy violation. Could be either; bias to auth unless reason hints credit.
    return /credit|quota|limit/.test(r) ? "credit" : "auth";
  }
  if (code === 1011 || code === 1006) return "network";
  return "unknown";
}

export function createElevenLabsClient(
  opts: ElevenLabsClientOptions,
): ElevenLabsClient {
  const {
    apiKey,
    sessionId,
    endpointUrl = DEFAULT_ENDPOINT,
    modelId = "scribe_v2",
    diarize = true,
    language,
    sampleRate = 16000,
    commitStrategy = "vad",
  } = opts;

  if (!apiKey) {
    throw new Error("[elevenLabs] apiKey is required");
  }

  let ws: WebSocket | null = null;
  let state: ElevenLabsState = "idle";
  const chunkSubs = new Set<ChunkCallback>();
  const errSubs = new Set<ErrorCallback>();
  const stateSubs = new Set<StateCallback>();

  // Track the speaker label of the most recent partial so committed events
  // without an explicit speaker_id inherit the last seen attribution. Scribe
  // v2 typically emits the speaker on every event, but we guard anyway.
  let lastSpeaker: string = "speaker_0";

  const setState = (next: ElevenLabsState) => {
    state = next;
    for (const cb of stateSubs) {
      try {
        cb(next);
      } catch (e) {
        console.error("[elevenLabs] state subscriber threw", e);
      }
    }
  };

  const emitChunk = (c: TranscriptChunk) => {
    for (const cb of chunkSubs) {
      try {
        cb(c);
      } catch (e) {
        console.error("[elevenLabs] chunk subscriber threw", e);
      }
    }
  };

  const emitError = (e: ElevenLabsError) => {
    for (const cb of errSubs) {
      try {
        cb(e);
      } catch (err) {
        console.error("[elevenLabs] error subscriber threw", err);
      }
    }
  };

  const buildUrl = (): string => {
    const u = new URL(endpointUrl);
    u.searchParams.set("model_id", modelId);
    if (diarize) u.searchParams.set("diarize", "true");
    if (language) u.searchParams.set("language", language);
    u.searchParams.set("sample_rate", String(sampleRate));
    // Browsers cannot set the `xi-api-key` header on a WebSocket.
    // ElevenLabs supports passing the key as a query param for the
    // browser-direct flow; we use that here. Document this in the README
    // and emphasize that the key MUST be scoped to STT only.
    u.searchParams.set("xi_api_key", apiKey);
    return u.toString();
  };

  const sendInitConfig = () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const cfg = {
      type: "config",
      audio_format: "pcm_s16le",
      sample_rate: sampleRate,
      model_id: modelId,
      diarize,
      language,
      vad: commitStrategy === "vad",
      commit_strategy: commitStrategy,
    };
    try {
      ws.send(JSON.stringify(cfg));
    } catch (e) {
      console.error("[elevenLabs] failed to send config", e);
    }
  };

  // Translate a Scribe message (any of the documented event types) into
  // a TranscriptChunk. Returns null if the message is not transcript-bearing.
  const messageToChunk = (msg: unknown): TranscriptChunk | null => {
    if (!msg || typeof msg !== "object") return null;
    const m = msg as Record<string, unknown>;

    const type = (m.type as string | undefined) ?? "";

    // Scribe v2 documented event names we recognize, with several aliases
    // because the schema has shifted. Keep this permissive.
    const isPartial =
      type === "partial_transcript" ||
      type === "interim_transcript" ||
      type === "interim" ||
      type === "partial" ||
      m.is_final === false;

    const isFinal =
      type === "committed_transcript" ||
      type === "final_transcript" ||
      type === "transcript" ||
      type === "final" ||
      m.is_final === true;

    if (!isPartial && !isFinal) return null;

    // Pull the textual content. Scribe sometimes nests as { transcript: { text } }
    // or { text } directly, or { alternatives: [{ text }] }.
    let text: string | undefined;
    if (typeof m.text === "string") text = m.text;
    else if (m.transcript && typeof (m.transcript as { text?: string }).text === "string") {
      text = (m.transcript as { text: string }).text;
    } else if (Array.isArray(m.alternatives) && m.alternatives.length > 0) {
      const first = m.alternatives[0] as { text?: string } | undefined;
      if (first && typeof first.text === "string") text = first.text;
    }
    if (!text) return null;

    // Speaker id from diarization. Common keys: speaker_id, speaker, speaker_label.
    let speaker: string | undefined;
    if (typeof m.speaker_id === "string") speaker = m.speaker_id;
    else if (typeof m.speaker === "string") speaker = m.speaker;
    else if (typeof m.speaker_label === "string") speaker = m.speaker_label;
    else if (typeof m.speaker === "number") speaker = `speaker_${m.speaker}`;

    // If the event has word-level timing with per-word speakers, take the
    // dominant one.
    if (!speaker && Array.isArray(m.words) && m.words.length > 0) {
      const counts = new Map<string, number>();
      for (const w of m.words as Array<Record<string, unknown>>) {
        const sp =
          (typeof w.speaker_id === "string" && w.speaker_id) ||
          (typeof w.speaker === "string" && w.speaker) ||
          (typeof w.speaker === "number" && `speaker_${w.speaker}`) ||
          null;
        if (sp) counts.set(sp, (counts.get(sp) ?? 0) + 1);
      }
      let best: string | null = null;
      let bestN = -1;
      for (const [k, v] of counts) {
        if (v > bestN) {
          best = k;
          bestN = v;
        }
      }
      if (best) speaker = best;
    }

    if (speaker) lastSpeaker = speaker;

    return {
      type: "transcript",
      session_id: sessionId,
      speaker_id: speaker ?? lastSpeaker,
      text,
      is_final: !!isFinal,
      ts_client: Date.now(),
    };
  };

  const handleMessage = (data: string | ArrayBuffer | Blob) => {
    if (typeof data !== "string") {
      // Binary frames from server are unexpected for Scribe; ignore.
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      // Some endpoints may emit ndjson keepalives — drop silently.
      return;
    }

    // Error envelopes.
    if (parsed && typeof parsed === "object") {
      const m = parsed as Record<string, unknown>;
      const t = m.type as string | undefined;
      if (t === "error" || t === "transcribe_error") {
        const message = (m.message as string | undefined) ?? "unknown error";
        const code = m.code as number | undefined;
        const lower = message.toLowerCase();
        const kind: ElevenLabsError["kind"] =
          /credit|quota|limit|payment/.test(lower)
            ? "credit"
            : /unauth|forbidden|api.?key/.test(lower)
              ? "auth"
              : "transcribe";
        emitError({ kind, message, code, raw: parsed });
        return;
      }
    }

    const chunk = messageToChunk(parsed);
    if (chunk) emitChunk(chunk);
  };

  const connect = async (): Promise<void> => {
    if (ws) return;
    setState("connecting");
    return new Promise<void>((resolve, reject) => {
      let url: string;
      try {
        url = buildUrl();
      } catch (e) {
        setState("error");
        reject(e);
        return;
      }

      let socket: WebSocket;
      try {
        socket = new WebSocket(url);
      } catch (e) {
        setState("error");
        reject(e);
        return;
      }
      ws = socket;
      socket.binaryType = "arraybuffer";

      const onOpen = () => {
        setState("open");
        sendInitConfig();
        resolve();
      };

      const onErr = (ev: Event) => {
        emitError({
          kind: "network",
          message: "WebSocket error",
          raw: ev,
        });
        if (state === "connecting") {
          setState("error");
          reject(new Error("WebSocket failed to open"));
        }
      };

      const onClose = (ev: CloseEvent) => {
        const kind = classifyClose(ev.code, ev.reason ?? "");
        if (kind !== "unknown" || ev.code !== 1000) {
          emitError({
            kind,
            message: ev.reason || `WebSocket closed (${ev.code})`,
            code: ev.code,
          });
        }
        ws = null;
        setState("closed");
        if (state === "connecting") {
          reject(new Error(`WebSocket closed before open (${ev.code})`));
        }
      };

      const onMsg = (ev: MessageEvent) => {
        handleMessage(ev.data);
      };

      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onErr);
      socket.addEventListener("close", onClose);
      socket.addEventListener("message", onMsg);
    });
  };

  const sendAudio = (pcm16: Int16Array): void => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // Scribe accepts raw binary PCM frames. Always send the underlying bytes,
    // not the typed array view (some endpoints reject typed arrays directly).
    try {
      ws.send(
        pcm16.buffer.slice(
          pcm16.byteOffset,
          pcm16.byteOffset + pcm16.byteLength,
        ),
      );
    } catch (e) {
      emitError({
        kind: "network",
        message: "send failed",
        raw: e,
      });
    }
  };

  const commit = (): void => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: "commit" }));
    } catch {
      /* noop */
    }
  };

  const close = async (code = 1000, reason = "client closing"): Promise<void> => {
    if (!ws) {
      setState("closed");
      return;
    }
    setState("closing");
    try {
      // Polite end-of-stream signal before close.
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "end_of_stream" }));
      }
    } catch {
      /* noop */
    }
    try {
      ws.close(code, reason);
    } catch {
      /* noop */
    }
    ws = null;
    setState("closed");
  };

  const onChunk = (cb: ChunkCallback) => {
    chunkSubs.add(cb);
    return () => chunkSubs.delete(cb);
  };
  const onError = (cb: ErrorCallback) => {
    errSubs.add(cb);
    return () => errSubs.delete(cb);
  };
  const onState = (cb: StateCallback) => {
    stateSubs.add(cb);
    return () => stateSubs.delete(cb);
  };
  const getState = () => state;

  return {
    connect,
    sendAudio,
    commit,
    close,
    onChunk,
    onError,
    onState,
    getState,
  };
}

// Exported for unit tests.
export const __test__ = { classifyClose };
