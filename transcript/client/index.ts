// Public API barrel for @mindmap/transcript-client.
//
// The frontend imports from here:
//   import { createTranscriptPipeline } from "@mindmap/transcript-client";

export {
  createTranscriptPipeline,
  type CreateTranscriptPipelineOptions,
  type TranscriptPipelineHandle,
  type FallbackReason,
} from "./transcriptClient";

export {
  createMicCapture,
  type MicCaptureHandle,
  type MicCaptureOptions,
  type AudioChunkCallback,
} from "./micCapture";

export {
  createElevenLabsClient,
  type ElevenLabsClient,
  type ElevenLabsClientOptions,
  type ElevenLabsError,
  type ElevenLabsState,
} from "./elevenLabsClient";

export {
  createWebSpeechFallback,
  type WebSpeechFallbackHandle,
  type WebSpeechFallbackOptions,
  type WebSpeechError,
} from "./webSpeechFallback";

export {
  createBackendBridge,
  type BackendBridgeHandle,
  type BackendBridgeOptions,
} from "./backendBridge";

// Stub — throws on call. Kept here so callers can detect its presence.
export {
  createGroqWhisperFallback,
  type GroqWhisperFallbackHandle,
  type GroqWhisperFallbackOptions,
} from "./groqWhisperFallback";
