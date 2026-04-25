// transcriptClient.ts
//
// Top-level orchestrator. Tries ElevenLabs Scribe v2 first; auto-swaps to the
// Web Speech API fallback on auth/credit errors or repeated transcription
// failures. The fallback swap is NEVER silent: we always invoke the
// onFallbackActivated callback so the UI can surface a Sonner toast.

import type { TranscriptChunk } from "../../shared/ws_messages";
import { createMicCapture, type MicCaptureHandle } from "./micCapture";
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

export interface CreateTranscriptPipelineOptions {
  sessionId: string;
  onChunk: (chunk: TranscriptChunk) => void;
  onFallbackActivated?: (reason: FallbackReason, detail?: string) => void;
  // Override the API key (defaults to import.meta.env.VITE_ELEVENLABS_API_KEY).
  apiKey?: string;
  // Override the WS endpoint (passed through to elevenLabsClient).
  endpointUrl?: string;
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

export function createTranscriptPipeline(
  opts: CreateTranscriptPipelineOptions,
): TranscriptPipelineHandle {
  const apiKey = opts.apiKey ?? readEnvApiKey();
  const maxFailures = opts.maxConsecutiveFailures ?? 5;

  let mic: MicCaptureHandle | null = null;
  let eleven: ElevenLabsClient | null = null;
  let fallback: WebSpeechFallbackHandle | null = null;
  let usingFallback = false;
  let started = false;
  let consecutiveFailures = 0;

  const notifyFallback = (reason: FallbackReason, detail?: string) => {
    // Always log — never silent.
    console.warn(
      `[transcriptClient] swapping to Web Speech fallback (reason=${reason})${
        detail ? `: ${detail}` : ""
      }`,
    );
    opts.onFallbackActivated?.(reason, detail);
  };

  const teardownPrimary = async () => {
    if (mic) {
      try {
        await mic.stop();
      } catch {
        /* noop */
      }
      mic = null;
    }
    if (eleven) {
      try {
        await eleven.close(1000, "swapping to fallback");
      } catch {
        /* noop */
      }
      eleven = null;
    }
  };

  const swapToFallback = async (reason: FallbackReason, detail?: string) => {
    if (usingFallback) return;
    usingFallback = true;
    notifyFallback(reason, detail);
    await teardownPrimary();
    if (!started) return;
    fallback = createWebSpeechFallback({ sessionId: opts.sessionId });
    fallback.onChunk((c) => opts.onChunk(c));
    fallback.onError((err) => {
      console.error("[transcriptClient] webSpeech error", err);
    });
    fallback.start();
  };

  const startPrimary = async (): Promise<void> => {
    if (!apiKey) {
      await swapToFallback("no-api-key", "VITE_ELEVENLABS_API_KEY not set");
      return;
    }

    mic = createMicCapture({ deviceId: opts.deviceId });
    eleven = createElevenLabsClient({
      apiKey,
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
        void swapToFallback("auth", err.message);
        return;
      }
      if (err.kind === "credit") {
        void swapToFallback("credit", err.message);
        return;
      }
      if (err.kind === "transcribe") {
        consecutiveFailures += 1;
        if (consecutiveFailures >= maxFailures) {
          void swapToFallback(
            "repeated-failures",
            `${consecutiveFailures} consecutive transcription failures`,
          );
        }
        return;
      }
      // network/protocol errors are logged but don't immediately swap; the
      // close handler will surface auth/credit-coded closes if relevant.
      console.warn("[transcriptClient] elevenLabs error", err);
    });

    try {
      await eleven.connect();
    } catch (e) {
      // Connect failure — swap immediately so the demo doesn't dead-air.
      await swapToFallback(
        "connect-failure",
        e instanceof Error ? e.message : String(e),
      );
      return;
    }

    mic.onAudioChunk((pcm16) => {
      eleven?.sendAudio(pcm16);
    });
    await mic.start();
  };

  const start = async () => {
    if (started) return;
    started = true;
    consecutiveFailures = 0;
    if (opts.forceFallback) {
      await swapToFallback("manual", "forceFallback option set");
      return;
    }
    await startPrimary();
  };

  const stop = async () => {
    started = false;
    await teardownPrimary();
    if (fallback) {
      try {
        fallback.stop();
      } catch {
        /* noop */
      }
      fallback = null;
    }
    usingFallback = false;
  };

  const forceFallback = async (reason: FallbackReason = "manual") => {
    if (!started) {
      // Pre-set so a subsequent start() goes straight to fallback.
      opts.forceFallback = true; // eslint-disable-line no-param-reassign
      return;
    }
    await swapToFallback(reason, "forceFallback() called");
  };

  return {
    start,
    stop,
    isFallbackActive: () => usingFallback,
    forceFallback,
  };
}
