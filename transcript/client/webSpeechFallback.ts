// webSpeechFallback.ts
//
// Wraps the browser's SpeechRecognition (webkitSpeechRecognition) API and
// emits TranscriptChunk objects shaped per shared/ws_messages.ts.
//
// Web Speech does NOT do diarization. We fake a stable speaker_id per browser
// tab using a UUID stored in sessionStorage so the backend can still color-code
// nodes — but every chunk in this path will share the same id.
//
// MANDATORY: restartGuard. Chrome aborts SpeechRecognition silently after
// roughly a minute of silence (the dreaded `onend` with no `onerror`). We
// detect every `onend` and immediately call recognition.start() again as
// long as the consumer hasn't called stop(). Without this, demos die.

import type { TranscriptChunk } from "../../shared/ws_messages";

export type WebSpeechChunkCallback = (chunk: TranscriptChunk) => void;
export type WebSpeechErrorCallback = (err: WebSpeechError) => void;

export interface WebSpeechError {
  kind: "unsupported" | "permission" | "network" | "no-speech" | "aborted" | "unknown";
  message: string;
  raw?: unknown;
}

export interface WebSpeechFallbackOptions {
  sessionId: string;
  language?: string; // BCP-47, defaults to navigator.language
  speakerIdStorageKey?: string; // sessionStorage key — defaults to "mindmap:webSpeechSpeakerId"
}

export interface WebSpeechFallbackHandle {
  start: () => void;
  stop: () => void;
  isActive: () => boolean;
  onChunk: (cb: WebSpeechChunkCallback) => () => void;
  onError: (cb: WebSpeechErrorCallback) => () => void;
  getSpeakerId: () => string;
}

// Minimal type surface for the prefixed/non-prefixed SpeechRecognition.
// We intentionally don't depend on lib.dom.d.ts shapes that vary between
// TS versions.
interface MinimalSpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives?: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onerror: ((ev: SpeechRecognitionErrorEventLike) => void) | null;
  onend: ((ev: Event) => void) | null;
  onstart: ((ev: Event) => void) | null;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  length: number;
  0: { transcript: string; confidence?: number };
}

interface SpeechRecognitionResultListLike {
  length: number;
  [index: number]: SpeechRecognitionResultLike;
}

interface SpeechRecognitionEventLike extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultListLike;
}

interface SpeechRecognitionErrorEventLike extends Event {
  error: string;
  message?: string;
}

type SpeechRecognitionCtor = new () => MinimalSpeechRecognition;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = globalThis as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function getOrCreateSpeakerId(storageKey: string): string {
  try {
    const existing = sessionStorage.getItem(storageKey);
    if (existing) return existing;
    const fresh =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `tab_${Math.random().toString(36).slice(2, 10)}`;
    const id = `speaker_${fresh}`;
    sessionStorage.setItem(storageKey, id);
    return id;
  } catch {
    // sessionStorage may be blocked (private mode, sandboxed iframe).
    return `speaker_${Math.random().toString(36).slice(2, 10)}`;
  }
}

export function createWebSpeechFallback(
  opts: WebSpeechFallbackOptions,
): WebSpeechFallbackHandle {
  const storageKey = opts.speakerIdStorageKey ?? "mindmap:webSpeechSpeakerId";
  const speakerId = getOrCreateSpeakerId(storageKey);
  const language =
    opts.language ?? (typeof navigator !== "undefined" ? navigator.language : "en-US") ?? "en-US";

  const chunkSubs = new Set<WebSpeechChunkCallback>();
  const errSubs = new Set<WebSpeechErrorCallback>();

  let recognition: MinimalSpeechRecognition | null = null;
  // The user's intent — true between explicit start() and stop() calls.
  let active = false;
  // Backoff for restart loop in case onend keeps firing immediately.
  let restartAttempts = 0;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;

  const emitChunk = (text: string, isFinal: boolean) => {
    if (!text) return;
    const chunk: TranscriptChunk = {
      type: "transcript",
      session_id: opts.sessionId,
      speaker_id: speakerId,
      text,
      is_final: isFinal,
      ts_client: Date.now(),
    };
    for (const cb of chunkSubs) {
      try {
        cb(chunk);
      } catch (e) {
        console.error("[webSpeech] chunk subscriber threw", e);
      }
    }
  };

  const emitError = (e: WebSpeechError) => {
    for (const cb of errSubs) {
      try {
        cb(e);
      } catch (err) {
        console.error("[webSpeech] error subscriber threw", err);
      }
    }
  };

  const buildRecognition = (): MinimalSpeechRecognition | null => {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      emitError({
        kind: "unsupported",
        message:
          "SpeechRecognition is not available in this browser. Use Chrome or Edge.",
      });
      return null;
    }
    const r = new Ctor();
    r.continuous = true;
    r.interimResults = true;
    r.lang = language;
    if ("maxAlternatives" in r) r.maxAlternatives = 1;

    r.onresult = (ev) => {
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const result = ev.results[i];
        if (!result || result.length === 0) continue;
        const alt = result[0];
        const text = (alt?.transcript ?? "").trim();
        if (!text) continue;
        emitChunk(text, !!result.isFinal);
      }
    };

    r.onerror = (ev) => {
      const errStr = ev.error || "unknown";
      const kind: WebSpeechError["kind"] =
        errStr === "not-allowed" || errStr === "service-not-allowed"
          ? "permission"
          : errStr === "network"
            ? "network"
            : errStr === "no-speech"
              ? "no-speech"
              : errStr === "aborted"
                ? "aborted"
                : "unknown";
      emitError({ kind, message: ev.message || errStr, raw: ev });
      // Do NOT stop active here; the onend handler decides whether to restart.
      // For permission errors, however, restarting is pointless.
      if (kind === "permission") active = false;
    };

    // restartGuard: this is the load-bearing piece. If the user still wants
    // recognition active, restart. Use a tiny backoff so we don't spin if the
    // browser is rejecting starts immediately.
    r.onend = () => {
      if (!active) return;
      restartAttempts += 1;
      const delay = Math.min(50 * restartAttempts, 2000);
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = setTimeout(() => {
        if (!active) return;
        try {
          recognition?.start();
          // Reset attempts after a successful start (we'll know via onstart).
        } catch (e) {
          // Some browsers throw if start() is called too quickly after onend.
          // Try once more after a longer delay.
          if (active && restartAttempts < 20) {
            restartTimer = setTimeout(() => {
              try {
                recognition?.start();
              } catch (err) {
                emitError({
                  kind: "unknown",
                  message: "Failed to auto-restart SpeechRecognition",
                  raw: err,
                });
              }
            }, 500);
          } else {
            emitError({
              kind: "unknown",
              message: "Restart loop exceeded max attempts",
              raw: e,
            });
            active = false;
          }
        }
      }, delay);
    };

    r.onstart = () => {
      restartAttempts = 0;
    };

    return r;
  };

  const start = () => {
    if (active) return;
    active = true;
    recognition = buildRecognition();
    if (!recognition) {
      active = false;
      return;
    }
    try {
      recognition.start();
    } catch (e) {
      // InvalidStateError if already started; safe to ignore.
      console.warn("[webSpeech] start threw — assuming already running", e);
    }
  };

  const stop = () => {
    active = false;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    if (!recognition) return;
    try {
      recognition.stop();
    } catch {
      try {
        recognition.abort();
      } catch {
        /* noop */
      }
    }
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    recognition.onstart = null;
    recognition = null;
  };

  const onChunk = (cb: WebSpeechChunkCallback) => {
    chunkSubs.add(cb);
    return () => chunkSubs.delete(cb);
  };
  const onError = (cb: WebSpeechErrorCallback) => {
    errSubs.add(cb);
    return () => errSubs.delete(cb);
  };

  return {
    start,
    stop,
    isActive: () => active,
    onChunk,
    onError,
    getSpeakerId: () => speakerId,
  };
}
