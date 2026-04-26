// transcriptClient.ts
//
// Top-level orchestrator. Tries providers in order:
//   1. AssemblyAI Universal-Streaming v3 (best diarization, paid) — used
//      when the backend's /internal/assembly-token endpoint mints a
//      token successfully (i.e. ASSEMBLYAI_API_KEY is set server-side).
//   2. ElevenLabs Scribe v2 (in-browser key from VITE_ELEVENLABS_API_KEY).
//   3. Web Speech API (browser-native, free, no diarization).
//
// The fallback chain is never silent: every swap fires
// onFallbackActivated so the UI can surface a Sonner toast.

import type { TranscriptChunk } from "../../shared/ws_messages";
import { createMicCapture, type MicCaptureHandle } from "./micCapture";
import {
  createAssemblyAIClient,
  type AssemblyAIClient,
  type AssemblyAIError,
} from "./assemblyAIClient";
import {
  createElevenLabsClient,
  type ElevenLabsClient,
  type ElevenLabsError,
} from "./elevenLabsClient";
import {
  createWebSpeechFallback,
  type WebSpeechFallbackHandle,
} from "./webSpeechFallback";

export type FallbackReason =
  | "auth"
  | "credit"
  | "repeated-failures"
  | "no-api-key"
  | "manual"
  | "connect-failure";

export type ProviderName = "assemblyai" | "elevenlabs" | "webspeech";

export interface CreateTranscriptPipelineOptions {
  sessionId: string;
  onChunk: (chunk: TranscriptChunk) => void;
  onFallbackActivated?: (reason: FallbackReason, detail?: string) => void;
  /** Notified each time we land on a working provider. Useful for UI. */
  onProviderChange?: (provider: ProviderName) => void;
  // Override the ElevenLabs API key (defaults to VITE_ELEVENLABS_API_KEY).
  apiKey?: string;
  // Override the ElevenLabs WS endpoint.
  endpointUrl?: string;
  /** URL of the backend's AssemblyAI token-mint endpoint. Defaults to
   *  ${VITE_BACKEND_URL}/internal/assembly-token. */
  assemblyTokenUrl?: string;
  /** Override the AssemblyAI WS endpoint (rarely needed). */
  assemblyEndpointUrl?: string;
  // Optional mic device.
  deviceId?: string;
  // Force the fallback path (useful for the demo toggle and tests).
  forceFallback?: boolean;
  // Number of consecutive "transcribe" errors to tolerate before swap.
  maxConsecutiveFailures?: number;
}

export interface TranscriptPipelineHandle {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  isFallbackActive: () => boolean;
  forceFallback: (reason?: FallbackReason) => Promise<void>;
}

function readEnvApiKey(): string | undefined {
  try {
    const env = (import.meta as unknown as { env?: Record<string, string> }).env;
    return env?.VITE_ELEVENLABS_API_KEY;
  } catch {
    return undefined;
  }
}

function defaultAssemblyTokenUrl(): string {
  try {
    const env = (import.meta as unknown as { env?: Record<string, string> }).env;
    const base = env?.VITE_BACKEND_URL ?? "http://localhost:8000";
    return `${base.replace(/\/$/, "")}/internal/assembly-token`;
  } catch {
    return "http://localhost:8000/internal/assembly-token";
  }
}

export function createTranscriptPipeline(
  opts: CreateTranscriptPipelineOptions,
): TranscriptPipelineHandle {
  const elevenApiKey = opts.apiKey ?? readEnvApiKey();
  const assemblyTokenUrl = opts.assemblyTokenUrl ?? defaultAssemblyTokenUrl();
  const maxFailures = opts.maxConsecutiveFailures ?? 5;

  let mic: MicCaptureHandle | null = null;
  let assembly: AssemblyAIClient | null = null;
  let eleven: ElevenLabsClient | null = null;
  let fallback: WebSpeechFallbackHandle | null = null;
  let provider: ProviderName | null = null;
  let started = false;
  let consecutiveFailures = 0;

  const setProvider = (next: ProviderName) => {
    if (provider === next) return;
    provider = next;
    opts.onProviderChange?.(next);
  };

  const notifyFallback = (reason: FallbackReason, detail?: string) => {
    // Always log — never silent.
    console.warn(
      `[transcriptClient] fallback swap (reason=${reason})${
        detail ? `: ${detail}` : ""
      }`,
    );
    opts.onFallbackActivated?.(reason, detail);
  };

  const teardownAssembly = async () => {
    if (assembly) {
      try {
        await assembly.close(1000, "swapping providers");
      } catch {
        /* noop */
      }
      assembly = null;
    }
  };

  const teardownEleven = async () => {
    if (eleven) {
      try {
        await eleven.close(1000, "swapping providers");
      } catch {
        /* noop */
      }
      eleven = null;
    }
  };

  const teardownMic = async () => {
    if (mic) {
      try {
        await mic.stop();
      } catch {
        /* noop */
      }
      mic = null;
    }
  };

  const swapToWebSpeech = async (reason: FallbackReason, detail?: string) => {
    if (provider === "webspeech") return;
    notifyFallback(reason, detail);
    await teardownAssembly();
    await teardownEleven();
    await teardownMic();
    setProvider("webspeech");
    if (!started) return;
    fallback = createWebSpeechFallback({ sessionId: opts.sessionId });
    fallback.onChunk((c) => opts.onChunk(c));
    fallback.onError((err) => {
      console.error("[transcriptClient] webSpeech error", err);
    });
    fallback.start();
  };

  const tryElevenLabs = async (): Promise<boolean> => {
    if (!elevenApiKey) return false;
    await teardownAssembly(); // ensure assembly is gone
    if (!mic) mic = createMicCapture({ deviceId: opts.deviceId });

    eleven = createElevenLabsClient({
      apiKey: elevenApiKey,
      sessionId: opts.sessionId,
      endpointUrl: opts.endpointUrl,
      diarize: true,
      commitStrategy: "vad",
    });

    eleven.onChunk((chunk) => {
      consecutiveFailures = 0;
      opts.onChunk(chunk);
    });

    eleven.onError((err: ElevenLabsError) => {
      if (err.kind === "auth") {
        void swapToWebSpeech("auth", `elevenlabs: ${err.message}`);
        return;
      }
      if (err.kind === "credit") {
        void swapToWebSpeech("credit", `elevenlabs: ${err.message}`);
        return;
      }
      if (err.kind === "transcribe") {
        consecutiveFailures += 1;
        if (consecutiveFailures >= maxFailures) {
          void swapToWebSpeech(
            "repeated-failures",
            `${consecutiveFailures} consecutive transcription failures (elevenlabs)`,
          );
        }
        return;
      }
      console.warn("[transcriptClient] elevenLabs error", err);
    });

    try {
      await eleven.connect();
    } catch (e) {
      console.warn(
        "[transcriptClient] elevenLabs connect failed:",
        e instanceof Error ? e.message : String(e),
      );
      await teardownEleven();
      return false;
    }

    setProvider("elevenlabs");
    mic.onAudioChunk((pcm16) => eleven?.sendAudio(pcm16));
    // micCapture.start is idempotent (no-ops if already running), so this
    // is safe whether we re-used the mic from the assembly attempt or it's
    // fresh.
    await mic.start();
    return true;
  };

  const tryAssemblyAI = async (): Promise<boolean> => {
    if (!mic) mic = createMicCapture({ deviceId: opts.deviceId });

    assembly = createAssemblyAIClient({
      tokenUrl: assemblyTokenUrl,
      sessionId: opts.sessionId,
      endpointUrl: opts.assemblyEndpointUrl,
    });

    assembly.onChunk((chunk) => {
      consecutiveFailures = 0;
      opts.onChunk(chunk);
    });

    assembly.onError((err: AssemblyAIError) => {
      if (err.kind === "auth") {
        // server didn't have a key, or AssemblyAI rejected it — fall through
        // to the next provider. NOT directly to webspeech: we want elevenlabs
        // to get a chance.
        console.warn("[transcriptClient] assemblyai auth error", err);
        return;
      }
      if (err.kind === "credit") {
        console.warn("[transcriptClient] assemblyai credit exhausted", err);
        return;
      }
      if (err.kind === "transcribe") {
        consecutiveFailures += 1;
        if (consecutiveFailures >= maxFailures) {
          void swapToWebSpeech(
            "repeated-failures",
            `${consecutiveFailures} consecutive transcription failures (assemblyai)`,
          );
        }
        return;
      }
      console.warn("[transcriptClient] assemblyai error", err);
    });

    try {
      await assembly.connect();
    } catch (e) {
      console.warn(
        "[transcriptClient] assemblyai connect failed:",
        e instanceof Error ? (e as Error).message : String(e),
      );
      await teardownAssembly();
      return false;
    }

    setProvider("assemblyai");
    mic.onAudioChunk((pcm16) => assembly?.sendAudio(pcm16));
    await mic.start();
    return true;
  };

  const startChain = async (): Promise<void> => {
    // 1. AssemblyAI (best when a server-side key is configured).
    if (await tryAssemblyAI()) return;

    // 2. ElevenLabs (browser-direct).
    if (await tryElevenLabs()) return;

    // 3. Web Speech (always available in Chrome/Edge).
    await swapToWebSpeech(
      elevenApiKey ? "connect-failure" : "no-api-key",
      "all primary providers unavailable",
    );
  };

  const start = async () => {
    if (started) return;
    started = true;
    consecutiveFailures = 0;
    if (opts.forceFallback) {
      await swapToWebSpeech("manual", "forceFallback option set");
      return;
    }
    await startChain();
  };

  const stop = async () => {
    started = false;
    await teardownAssembly();
    await teardownEleven();
    await teardownMic();
    if (fallback) {
      try {
        fallback.stop();
      } catch {
        /* noop */
      }
      fallback = null;
    }
    provider = null;
  };

  const forceFallback = async (reason: FallbackReason = "manual") => {
    if (!started) {
      // Pre-set so a subsequent start() goes straight to fallback.
      opts.forceFallback = true; // eslint-disable-line no-param-reassign
      return;
    }
    await swapToWebSpeech(reason, "forceFallback() called");
  };

  return {
    start,
    stop,
    isFallbackActive: () => provider === "webspeech",
    forceFallback,
  };
}
