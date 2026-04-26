// diarizeUploader.ts
//
// Quietly buffers raw mic PCM during a session and uploads it to the
// backend's /internal/diarize-batch endpoint every ~30 s and on stop.
// The backend runs an AssemblyAI batch transcription with
// speaker_labels=true in a background task; the result is cached
// per-session and read by the artifact agent at Generate time.
//
// This module is *purely additive*. It taps the same Int16Array chunks
// that already flow into the streaming WS — no extra mic capture, no
// extra audio processing. If anything in this path fails (network,
// backend down, AssemblyAI throttled), the streaming + Generate paths
// behave exactly as they do today; the only effect is that artifacts
// won't have speaker info that round.

export interface DiarizeUploaderOptions {
  /** Where to POST audio. Defaults to ${VITE_BACKEND_URL}/internal/diarize-batch. */
  uploadUrl?: string;
  /** Mic sample rate. Defaults to 16000 — must match what micCapture emits. */
  sampleRate?: number;
  /** Upload cadence while mic is active. Default 30 s. */
  intervalMs?: number;
  /** sessionId — required, attached as ?session_id=… on the upload. */
  sessionId: string;
}

export interface DiarizeUploaderHandle {
  /** Append a freshly-captured chunk to the running buffer. */
  push: (pcm16: Int16Array) => void;
  /** Trigger a periodic-style upload immediately. Idempotent. */
  flushNow: () => Promise<void>;
  /** Stop the periodic timer + flush one last time. */
  stop: () => Promise<void>;
}

function defaultUploadUrl(sessionId: string): string {
  let base = "http://localhost:8000";
  try {
    const env = (import.meta as unknown as { env?: Record<string, string> }).env;
    base = env?.VITE_BACKEND_URL ?? base;
  } catch {
    /* noop in non-vite environments */
  }
  return `${base.replace(/\/$/, "")}/internal/diarize-batch?session_id=${encodeURIComponent(
    sessionId,
  )}`;
}

/**
 * Build a 16-bit PCM WAV ArrayBuffer from accumulated samples. Pure
 * function — separated so tests can assert byte layout without
 * depending on the Blob API (Node test env doesn't ship Blob.arrayBuffer
 * everywhere). The wrapper that builds an actual Blob calls this.
 */
export function buildWavBuffer(samples: Int16Array, sampleRate: number): ArrayBuffer {
  const numSamples = samples.length;
  const numBytes = numSamples * 2;
  const buffer = new ArrayBuffer(44 + numBytes);
  const view = new DataView(buffer);
  // RIFF header
  writeStr(view, 0, "RIFF");
  view.setUint32(4, 36 + numBytes, true);
  writeStr(view, 8, "WAVE");
  // fmt chunk
  writeStr(view, 12, "fmt ");
  view.setUint32(16, 16, true); // chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  // data chunk
  writeStr(view, 36, "data");
  view.setUint32(40, numBytes, true);
  // samples (little-endian) — `!` because we just allocated samples
  // with this exact length so every index is in-bounds.
  for (let i = 0; i < numSamples; i++) {
    view.setInt16(44 + i * 2, samples[i]!, true);
  }
  return buffer;
}

export function buildWavBlob(samples: Int16Array, sampleRate: number): Blob {
  return new Blob([buildWavBuffer(samples, sampleRate)], { type: "audio/wav" });
}

function writeStr(view: DataView, offset: number, s: string): void {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
}

/**
 * Concatenate two Int16Arrays without holding both intermediate views
 * around longer than necessary. Caller passes in the existing buffer
 * + the new chunk; we return the merged Int16Array.
 */
export function appendChunk(buffer: Int16Array, chunk: Int16Array): Int16Array {
  const out = new Int16Array(buffer.length + chunk.length);
  out.set(buffer, 0);
  out.set(chunk, buffer.length);
  return out;
}

export function createDiarizeUploader(
  opts: DiarizeUploaderOptions,
): DiarizeUploaderHandle {
  const sampleRate = opts.sampleRate ?? 16000;
  const intervalMs = opts.intervalMs ?? 30_000;
  const uploadUrl = opts.uploadUrl ?? defaultUploadUrl(opts.sessionId);

  let buffer: Int16Array = new Int16Array(0);
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let inFlight = false;

  const push = (pcm16: Int16Array): void => {
    if (stopped) return;
    if (pcm16.length === 0) return;
    buffer = appendChunk(buffer, pcm16);
  };

  const doUpload = async (): Promise<void> => {
    // Skip if nothing to upload OR a previous upload is still in flight
    // (no point spawning concurrent uploads of the same session).
    if (inFlight) return;
    if (buffer.length < sampleRate) return; // <1 s — not worth diarizing
    inFlight = true;
    const snapshot = buffer; // snapshot the entire session's audio
    try {
      const blob = buildWavBlob(snapshot, sampleRate);
      const res = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body: blob,
      });
      if (!res.ok) {
        // eslint-disable-next-line no-console
        console.warn(
          `[diarizeUploader] upload HTTP ${res.status} — ignoring (artifact will run without speaker info this round)`,
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[diarizeUploader] upload network error:", err);
    } finally {
      inFlight = false;
    }
  };

  const flushNow = async (): Promise<void> => {
    await doUpload();
  };

  // Schedule periodic uploads
  timer = setInterval(() => {
    void doUpload();
  }, intervalMs);

  const stop = async (): Promise<void> => {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    // One final upload so the most-complete audio is on the backend.
    await doUpload();
  };

  return { push, flushNow, stop };
}

// Test seam — pure helpers exposed for unit tests.
export const __test__ = {
  buildWavBlob,
  buildWavBuffer,
  appendChunk,
  defaultUploadUrl,
};
