// useTranscriptPipeline
//
// The single integration point that turns the mic button from a placebo into
// a real driver of the speech → backend → topology agent → graph events
// pipeline.
//
// When `enabled` flips to true (and a sessionId exists) we:
//   1. createTranscriptPipeline (ElevenLabs Scribe v2 primary, Web Speech
//      fallback) from @mindmap/transcript-client.
//   2. createBackendBridge to ws://.../ws/transcript so chunks reach the
//      backend's transcript_socket → ring buffer → topology agent path.
//   3. Forward every chunk into both the bridge AND the local optimistic
//      ghost extractor so partials seed ghost nodes immediately.
//   4. On fallback activation, surface a Sonner toast.
//
// On disable / unmount we tear everything down cleanly.

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import {
  createBackendBridge,
  createTranscriptPipeline,
  type BackendBridgeHandle,
  type FallbackReason,
  type TranscriptPipelineHandle,
} from "@mindmap/transcript-client";
import type { TranscriptChunk } from "@shared/ws_messages";
import {
  processTranscriptFinal,
  processTranscriptPartial,
} from "@/lib/optimisticGhosts";
import { useTranscriptStore } from "@/state/transcriptStore";

export interface UseTranscriptPipelineArgs {
  sessionId: string | null;
  enabled: boolean;
  /** Optional notification when the pipeline swaps to a fallback. */
  onFallback?: (reason: FallbackReason, detail?: string) => void;
}

function backendWsUrl(): string {
  const base =
    (import.meta.env.VITE_BACKEND_WS_URL as string | undefined) ??
    "ws://localhost:8000";
  return `${base.replace(/\/$/, "")}/ws/transcript`;
}

export function useTranscriptPipeline({
  sessionId,
  enabled,
  onFallback,
}: UseTranscriptPipelineArgs): void {
  // Stable refs so the effect doesn't tear down on identity churn.
  const onFallbackRef = useRef(onFallback);
  useEffect(() => {
    onFallbackRef.current = onFallback;
  }, [onFallback]);

  useEffect(() => {
    if (!enabled || !sessionId) return;

    let pipeline: TranscriptPipelineHandle | null = null;
    let bridge: BackendBridgeHandle | null = null;
    let cancelled = false;

    const handleChunk = (chunk: TranscriptChunk) => {
      // 1. Forward to backend so the topology agent gets fed.
      bridge?.send(chunk);
      // 2. Surface in the live caption stream so the user can SEE what
      //    is being captured (transcription quality is visible).
      const tStore = useTranscriptStore.getState();
      if (chunk.is_final) {
        tStore.pushFinal(chunk.speaker_id, chunk.text);
      } else {
        tStore.pushPartial(chunk.speaker_id, chunk.text);
      }
      // 3. Drive optimistic ghosts on BOTH partials and finals. The Groq /
      //    Gemini topology agents can saturate and silently emit empty
      //    diffs — the SWARM ghost layer keeps the canvas alive in that
      //    window. Partials use a short TTL; finals use a longer one.
      try {
        if (chunk.is_final) {
          processTranscriptFinal(chunk.text, chunk.speaker_id);
        } else {
          processTranscriptPartial(chunk.text, chunk.speaker_id);
        }
      } catch (err) {
        console.warn("[transcriptPipeline] ghost extractor failed", err);
      }
    };

    const handleFallback = (reason: FallbackReason, detail?: string) => {
      try {
        toast.warning("Using browser transcription fallback", {
          description: detail ?? `reason: ${reason}`,
        });
      } catch {
        /* toast may not be mounted in tests */
      }
      onFallbackRef.current?.(reason, detail);
    };

    const start = async () => {
      try {
        bridge = createBackendBridge({
          url: backendWsUrl(),
          onError: (err) => {
            console.warn("[transcriptPipeline] backend bridge error", err);
          },
        });
        bridge.connect();

        pipeline = createTranscriptPipeline({
          sessionId,
          onChunk: handleChunk,
          onFallbackActivated: handleFallback,
        });
        await pipeline.start();
      } catch (err) {
        console.error("[transcriptPipeline] failed to start", err);
        try {
          toast.error("Could not start microphone", {
            description: err instanceof Error ? err.message : String(err),
          });
        } catch {
          /* noop */
        }
      }
    };

    void start();

    return () => {
      cancelled = true;
      void (async () => {
        try {
          await pipeline?.stop();
        } catch (err) {
          console.warn("[transcriptPipeline] stop error", err);
        }
        try {
          bridge?.close();
        } catch (err) {
          console.warn("[transcriptPipeline] bridge close error", err);
        }
        // Reference cancelled to satisfy strict noUnusedLocals.
        void cancelled;
      })();
    };
  }, [enabled, sessionId]);
}
