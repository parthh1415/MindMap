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
  /** AssemblyAI v3 model. Default 'universal-streaming-english'.
   *  Valid (per AssemblyAI as of 2025-05-12 schema):
   *    - 'universal-streaming-english'      ← default, lowest latency
   *    - 'universal-streaming-multilingual'
   *    - 'whisper-rt'                       ← whisper, higher quality / latency
   *  AssemblyAI rejects the connection (close 3006) when this param is
   *  absent or invalid — discovered by direct probe. */
  speechModel?: string;
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
  // 3xxx range = AssemblyAI v3 protocol errors (3006 missing param,
  // 3007 input duration, ...). Surface as protocol so the orchestrator
  // can decide whether to retry / fall through.
  if (code >= 3000 && code < 4000) return "protocol";
  return "unknown";
}

/**
 * Pick the dominant speaker label across the words of a turn. AssemblyAI
 * v3 emits `speaker` per word; falls back to `speaker_default` when no
 * diarization signal is present (e.g. single-speaker mode).
 *
 * STATELESS — every call is independent. AssemblyAI's clustering can
 * relabel a returning speaker mid-session (A → C), which causes the
 * orb colour palette to shuffle identities even though the human is
 * the same person. For accurate multi-speaker tracking, prefer the
 * stateful `createSpeakerResolver()` below.
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

export interface SpeakerResolver {
  /**
   * Resolve a turn's words to a stable speaker_id. Applies a confidence
   * floor + sticky-prev rule for short / contested turns and remaps
   * AssemblyAI's volatile cluster labels to stable `speaker_N` ids in
   * order of first appearance.
   */
  resolve(
    words: Array<{ speaker?: string | number | null }> | undefined,
    isFinal: boolean,
  ): string;
  /**
   * Resolve a single raw turn-level speaker label directly. Used by
   * providers that emit one trusted speaker per turn (e.g. ElevenLabs
   * Scribe) rather than a tally of per-word labels. Skips the
   * confidence/short-turn gates — those are designed to suppress
   * per-word noise, which doesn't apply when the provider has already
   * decided. Still reuses the SAME idMap as `resolve()` so providers
   * that mix paths share consistent stable IDs.
   */
  resolveLabel(rawLabel: string | number | null | undefined, isFinal: boolean): string;
  /** Inspect-only — used in tests. */
  state(): {
    idMap: Record<string, string>;
    lastFinalSpeaker: string | null;
    nextIndex: number;
  };
}

/**
 * Confidence threshold below which a turn's "winning" speaker is rejected
 * and we stick to the previous speaker. 0.6 means the top label must
 * carry at least 60% of the words; otherwise the turn is too contested
 * to trust (typical case: a 2-word interjection misclassified across two
 * adjacent words). Tuned conservatively — the cost of sticking is "wrong
 * speaker on one short turn"; the cost of NOT sticking is the colour
 * palette shuffling on every "uh-huh".
 */
const SPEAKER_CONFIDENCE_FLOOR = 0.6;
/** A turn must carry at least this many words to even attempt to switch
 *  speakers. Below this, we always stick to the previous speaker. */
const SPEAKER_MIN_WORDS_TO_SWITCH = 3;

export function createSpeakerResolver(): SpeakerResolver {
  // AAi raw label (e.g. "A", "0", "B") → stable id (e.g. "speaker_0").
  // Assigned in order of first appearance, so speaker_0 is whoever
  // spoke first this session, regardless of how AAi later relabels.
  const idMap = new Map<string, string>();
  let nextIndex = 0;
  // Last id we accepted on a FINAL turn. Partial turns don't update
  // this — partials are unstable and would otherwise pin us to a
  // mid-utterance guess. This is also what we "stick to" for short
  // / low-confidence turns.
  let lastFinalSpeaker: string | null = null;

  const stableFor = (rawKey: string): string => {
    const existing = idMap.get(rawKey);
    if (existing) return existing;
    const stable = `speaker_${nextIndex}`;
    nextIndex += 1;
    idMap.set(rawKey, stable);
    return stable;
  };

  return {
    resolve(words, isFinal) {
      if (!words || words.length === 0) {
        return lastFinalSpeaker ?? "speaker_default";
      }

      // Tally raw labels.
      let labelled = 0;
      const tally = new Map<string, number>();
      for (const w of words) {
        const s = w.speaker;
        if (s === null || s === undefined) continue;
        const key = typeof s === "number" ? String(s) : String(s);
        tally.set(key, (tally.get(key) ?? 0) + 1);
        labelled += 1;
      }
      if (tally.size === 0 || labelled === 0) {
        return lastFinalSpeaker ?? "speaker_default";
      }

      // Pick the winning raw label.
      let bestRaw: string | null = null;
      let bestCount = -1;
      for (const [k, v] of tally) {
        if (v > bestCount) {
          bestRaw = k;
          bestCount = v;
        }
      }

      const winnerShare = bestCount / labelled;
      const tooShort = labelled < SPEAKER_MIN_WORDS_TO_SWITCH;
      const tooContested = winnerShare < SPEAKER_CONFIDENCE_FLOOR;
      // First-seen raw label = a new speaker entering the conversation.
      // Stickiness exists to suppress short interjections from already-
      // detected speakers, but it must NOT block a brand-new voice from
      // being registered — that would cap the conversation at whoever
      // happened to talk longest first. New speakers commit eagerly.
      const isNewSpeaker = bestRaw != null && !idMap.has(bestRaw);

      // Stick to previous speaker for short or contested turns — but
      // only when (a) we already have a previous speaker AND (b) the
      // dominant label is one we've seen before. First-ever turn and
      // first-ever appearance of a new label always commit.
      if (
        (tooShort || tooContested) &&
        lastFinalSpeaker &&
        !isNewSpeaker
      ) {
        return lastFinalSpeaker;
      }

      const stable = bestRaw ? stableFor(bestRaw) : "speaker_default";
      // Only commit on finals — partials shouldn't move the sticky
      // anchor since AAi's per-word labels can flicker mid-turn.
      if (isFinal) lastFinalSpeaker = stable;
      return stable;
    },
    resolveLabel(rawLabel, isFinal) {
      if (rawLabel === null || rawLabel === undefined) {
        return lastFinalSpeaker ?? "speaker_default";
      }
      const key = String(rawLabel);
      if (!key) {
        return lastFinalSpeaker ?? "speaker_default";
      }
      const stable = stableFor(key);
      if (isFinal) lastFinalSpeaker = stable;
      return stable;
    },
    state() {
      return {
        idMap: Object.fromEntries(idMap),
        lastFinalSpeaker,
        nextIndex,
      };
    },
  };
}

/**
 * Parse one server message (already JSON.parsed) into a TranscriptChunk
 * if it represents transcription content. Returns null for keep-alives
 * / Begin / Termination messages.
 */
export function parseAssemblyMessage(
  raw: unknown,
  sessionId: string,
  resolver?: SpeakerResolver,
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
      // Stateful resolver (preferred) is per-session, gives stable IDs
      // across the whole conversation, applies a confidence floor, and
      // sticks short/contested turns to the previous speaker. Stateless
      // fallback only kicks in when no resolver was passed (tests).
      speaker_id: resolver
        ? resolver.resolve(words, !!isFinal)
        : dominantSpeakerOfTurn(words),
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
  /** Buffer of pending samples not yet flushed to AssemblyAI. micCapture
   *  emits 20ms frames (320 samples), but AssemblyAI v3 requires frames
   *  between 50 and 1000 ms. We coalesce until ≥ MIN_BATCH_SAMPLES then
   *  flush. */
  audioBuffer: Int16Array;
}

// 16 kHz × 16-bit mono = 32000 bytes/s.
//   50 ms  =  800 samples (AssemblyAI's hard minimum)
//  100 ms  = 1600 samples (chosen — comfortable margin, still low latency)
// 1000 ms  = 16000 samples (AssemblyAI's hard maximum)
const MIN_BATCH_SAMPLES_16K = 1600; // 100 ms at 16 kHz

export function createAssemblyAIClient(
  opts: AssemblyAIClientOptions,
): AssemblyAIClient {
  const sampleRate = opts.sampleRate ?? 16000;
  const formatTurns = opts.formatTurns ?? true;
  const endpoint = opts.endpointUrl ?? DEFAULT_ENDPOINT;
  const tokenUrl = opts.tokenUrl;
  const sessionId = opts.sessionId;
  const speechModel = opts.speechModel ?? "universal-streaming-english";
  // One resolver per client lifetime — stable across reconnects within
  // the same session so a network blip doesn't reshuffle speaker IDs.
  const speakerResolver = createSpeakerResolver();

  const internal: InternalState = {
    socket: null,
    state: "idle",
    chunkSubs: new Set(),
    errorSubs: new Set(),
    stateSubs: new Set(),
    audioBuffer: new Int16Array(0),
  };

  // Per-batch sample count for the configured sampleRate. 100ms target
  // → 1600 samples at 16kHz. Comfortably above AssemblyAI's 50ms hard
  // floor, well below the 1000ms ceiling, low enough latency that the
  // user doesn't perceive the buffering.
  const minBatchSamples = Math.max(
    MIN_BATCH_SAMPLES_16K,
    Math.ceil(sampleRate * 0.1),
  );

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
    url.searchParams.set("speech_model", speechModel);
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
        // AssemblyAI sends `{type:"Error", error_code, error}` BEFORE
        // closing the WS on protocol violations. Surface the actual
        // message so we never get the silent "WS closed (3006) See
        // Error message for details" experience again.
        if (
          parsed &&
          typeof parsed === "object" &&
          (parsed as Record<string, unknown>).type === "Error"
        ) {
          const e = parsed as Record<string, unknown>;
          const code = Number(e.error_code ?? 0) || undefined;
          const message = String(e.error ?? "AssemblyAI error");
          // 3006 / 4xxx → auth/protocol-class; classify so the
          // orchestrator can decide on fallback.
          const lower = message.toLowerCase();
          let kind: AssemblyAIError["kind"] = "protocol";
          if (/token|unauth|forbidden|api[_ ]key/.test(lower)) kind = "auth";
          else if (/credit|quota|limit|insufficient|payment/.test(lower)) kind = "credit";
          emitError({ kind, message, code, raw: parsed });
          return;
        }
        const chunk = parseAssemblyMessage(parsed, sessionId, speakerResolver);
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

    // Coalesce incoming 20ms frames into ≥100ms batches.
    // AssemblyAI v3 closes the WS with code 3007 if any frame is
    // shorter than 50ms or longer than 1000ms.
    const prev = internal.audioBuffer;
    const merged = new Int16Array(prev.length + pcm16.length);
    merged.set(prev, 0);
    merged.set(pcm16, prev.length);
    internal.audioBuffer = merged;

    // Flush as many 100ms batches as we have. Each ws.send is one
    // discrete frame; sending the buffer in one shot is simpler and
    // also valid (any size ≤ 1000ms is accepted).
    if (internal.audioBuffer.length >= minBatchSamples) {
      const toSend = internal.audioBuffer;
      internal.audioBuffer = new Int16Array(0);
      ws.send(
        toSend.buffer.slice(toSend.byteOffset, toSend.byteOffset + toSend.byteLength),
      );
    }
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
  createSpeakerResolver,
  classifyClose,
  DEFAULT_ENDPOINT,
};
