// Ambient type shim for the @mindmap/transcript-client workspace package.
//
// Why: the real implementation lives at /transcript/client/*.ts and contains
// browser-specific code (SharedArrayBuffer / Blob unions) that doesn't
// type-check cleanly against the frontend's strict TS 6 settings. We don't
// own that file (it's owned by the transcript subagent) and bundler-mode
// tsc follows transitive imports even when files aren't listed in `include`.
//
// Solution: declare the public surface here (matches transcript/client/index.ts)
// and point the tsconfig path alias at this shim. Vite's runtime alias still
// points at the real index.ts so behavior at runtime is unchanged.

declare module "@mindmap/transcript-client" {
  import type { TranscriptChunk } from "@shared/ws_messages";

  // ── transcriptClient ────────────────────────────────────────────────
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
    apiKey?: string;
    endpointUrl?: string;
    deviceId?: string;
    forceFallback?: boolean;
    maxConsecutiveFailures?: number;
  }

  export interface TranscriptPipelineHandle {
    start: () => Promise<void>;
    stop: () => Promise<void>;
    isFallbackActive: () => boolean;
    forceFallback: (reason?: FallbackReason) => Promise<void>;
  }

  export function createTranscriptPipeline(
    opts: CreateTranscriptPipelineOptions,
  ): TranscriptPipelineHandle;

  // ── backendBridge ───────────────────────────────────────────────────
  export interface BackendBridgeOptions {
    url: string;
    bufferSize?: number;
    initialBackoffMs?: number;
    maxBackoffMs?: number;
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
  ): BackendBridgeHandle;

  // ── micCapture ──────────────────────────────────────────────────────
  export type AudioChunkCallback = (pcm16: ArrayBuffer) => void;

  export interface MicCaptureOptions {
    deviceId?: string;
    sampleRate?: number;
    chunkMs?: number;
  }

  export interface MicCaptureHandle {
    start: () => Promise<void>;
    stop: () => Promise<void>;
    onAudioChunk: (cb: AudioChunkCallback) => void;
  }

  export function createMicCapture(opts?: MicCaptureOptions): MicCaptureHandle;

  // ── elevenLabsClient ────────────────────────────────────────────────
  export type ElevenLabsState =
    | "idle"
    | "connecting"
    | "open"
    | "closing"
    | "closed";

  export interface ElevenLabsError {
    kind: "auth" | "credit" | "transcribe" | "network" | "protocol";
    message: string;
  }

  export interface ElevenLabsClientOptions {
    apiKey: string;
    sessionId: string;
    endpointUrl?: string;
    diarize?: boolean;
    commitStrategy?: "vad" | "manual";
  }

  export interface ElevenLabsClient {
    connect: () => Promise<void>;
    close: (code?: number, reason?: string) => Promise<void>;
    sendAudio: (pcm16: ArrayBuffer) => void;
    onChunk: (cb: (chunk: TranscriptChunk) => void) => void;
    onError: (cb: (err: ElevenLabsError) => void) => void;
    state: () => ElevenLabsState;
  }

  export function createElevenLabsClient(
    opts: ElevenLabsClientOptions,
  ): ElevenLabsClient;

  // ── webSpeechFallback ───────────────────────────────────────────────
  export interface WebSpeechError {
    kind: "unsupported" | "permission" | "runtime";
    message: string;
  }

  export interface WebSpeechFallbackOptions {
    sessionId: string;
    lang?: string;
  }

  export interface WebSpeechFallbackHandle {
    start: () => void;
    stop: () => void;
    onChunk: (cb: (chunk: TranscriptChunk) => void) => void;
    onError: (cb: (err: WebSpeechError) => void) => void;
  }

  export function createWebSpeechFallback(
    opts: WebSpeechFallbackOptions,
  ): WebSpeechFallbackHandle;

  // ── groqWhisperFallback (stub — throws on call) ─────────────────────
  export interface GroqWhisperFallbackOptions {
    sessionId: string;
  }
  export interface GroqWhisperFallbackHandle {
    start: () => Promise<void>;
    stop: () => Promise<void>;
  }
  export function createGroqWhisperFallback(
    opts: GroqWhisperFallbackOptions,
  ): GroqWhisperFallbackHandle;
}
