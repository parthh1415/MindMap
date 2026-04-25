// groqWhisperFallback.ts
//
// STUB ONLY — deferred per the project brief.
//
// TODO(transcript): Implement a Groq Whisper fallback that takes a MediaStream
// (or PCM frames from micCapture) and uses Groq's Whisper endpoint to produce
// TranscriptChunk events. This was deprioritized in favor of ElevenLabs Scribe
// v2 (primary, with diarization) and the Web Speech API (browser-native
// fallback). Add this when we want a third tier — e.g. for a Firefox path
// where Web Speech is unavailable.

import type { TranscriptChunk } from "../../shared/ws_messages";

export type GroqWhisperChunkCallback = (chunk: TranscriptChunk) => void;

export interface GroqWhisperFallbackOptions {
  apiKey: string;
  sessionId: string;
}

export interface GroqWhisperFallbackHandle {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  onChunk: (cb: GroqWhisperChunkCallback) => () => void;
}

export function createGroqWhisperFallback(
  _opts: GroqWhisperFallbackOptions,
): GroqWhisperFallbackHandle {
  throw new Error("not implemented: groqWhisperFallback is a deferred stub");
}
