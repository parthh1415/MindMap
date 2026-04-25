// micCapture.ts
//
// Wraps `navigator.mediaDevices.getUserMedia` and exposes a callback that
// emits 16-bit little-endian PCM frames at 16 kHz — the format ElevenLabs
// Scribe v2 expects on its realtime streaming endpoint.
//
// Strategy:
//   1. Create an AudioContext (best effort sampleRate: 16000 — Chrome may
//      ignore and pick the device's native rate, in which case we resample).
//   2. Try AudioWorklet first (modern, off-main-thread). If it fails (older
//      browsers, file:// protocol), fall back to ScriptProcessorNode.
//   3. Both paths emit Int16Array PCM chunks via `onAudioChunk`.

export type AudioChunkCallback = (pcm16: Int16Array) => void;

export interface MicCaptureOptions {
  deviceId?: string;
  // Target sample rate sent to the consumer. Scribe v2 expects 16000.
  targetSampleRate?: number;
  // Frame size (in samples at targetSampleRate). 320 samples = 20ms @ 16kHz.
  // Most realtime ASR endpoints prefer 20–100 ms frames.
  frameSize?: number;
}

export interface MicCaptureHandle {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  onAudioChunk: (cb: AudioChunkCallback) => () => void;
  isRunning: () => boolean;
}

const WORKLET_NAME = "mindmap-pcm-worklet";

// Inlined AudioWorklet processor source. Lives as a Blob URL at runtime
// so we don't need to ship a separate worklet file.
const WORKLET_SOURCE = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel) return true;
    // Copy because the buffer is recycled by the audio thread.
    const copy = new Float32Array(channel.length);
    copy.set(channel);
    this.port.postMessage(copy, [copy.buffer]);
    return true;
  }
}
registerProcessor(${JSON.stringify(WORKLET_NAME)}, PcmCaptureProcessor);
`;

function floatTo16BitPCM(float32: Float32Array): Int16Array {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i] ?? 0));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

// Linear-interpolation downsample from `inRate` to `outRate`. Good enough
// for speech at 48k → 16k, which is the common case.
function resampleLinear(
  input: Float32Array,
  inRate: number,
  outRate: number,
): Float32Array {
  if (inRate === outRate) return input;
  const ratio = inRate / outRate;
  const newLen = Math.floor(input.length / ratio);
  const out = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) {
    const idx = i * ratio;
    const lo = Math.floor(idx);
    const hi = Math.min(lo + 1, input.length - 1);
    const t = idx - lo;
    out[i] = (input[lo] ?? 0) * (1 - t) + (input[hi] ?? 0) * t;
  }
  return out;
}

export function createMicCapture(opts: MicCaptureOptions = {}): MicCaptureHandle {
  const targetSampleRate = opts.targetSampleRate ?? 16000;
  const frameSize = opts.frameSize ?? 320; // 20ms @ 16k

  let mediaStream: MediaStream | null = null;
  let audioCtx: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let workletNode: AudioWorkletNode | null = null;
  let scriptNode: ScriptProcessorNode | null = null;
  let workletUrl: string | null = null;
  let running = false;

  // Accumulator for resampled PCM until we have `frameSize` samples to emit.
  let accumulator: Float32Array = new Float32Array(0);
  const subscribers = new Set<AudioChunkCallback>();

  const emit = (pcm16: Int16Array) => {
    for (const cb of subscribers) {
      try {
        cb(pcm16);
      } catch (err) {
        // Don't let one bad subscriber break the audio path.
        console.error("[micCapture] subscriber threw", err);
      }
    }
  };

  const handleFloat32 = (chunk: Float32Array, srcRate: number) => {
    const resampled = resampleLinear(chunk, srcRate, targetSampleRate);
    // Append to accumulator.
    const merged = new Float32Array(accumulator.length + resampled.length);
    merged.set(accumulator, 0);
    merged.set(resampled, accumulator.length);
    accumulator = merged;

    while (accumulator.length >= frameSize) {
      const frame = accumulator.subarray(0, frameSize);
      emit(floatTo16BitPCM(frame));
      accumulator = accumulator.subarray(frameSize);
    }
  };

  const start = async () => {
    if (running) return;
    if (!navigator?.mediaDevices?.getUserMedia) {
      throw new Error("getUserMedia not available — HTTPS or localhost required");
    }

    const constraints: MediaStreamConstraints = {
      audio: {
        deviceId: opts.deviceId ? { exact: opts.deviceId } : undefined,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
      video: false,
    };
    mediaStream = await navigator.mediaDevices.getUserMedia(constraints);

    // Best-effort 16k context. Browsers may override; we resample either way.
    const Ctor: typeof AudioContext =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    try {
      audioCtx = new Ctor({ sampleRate: targetSampleRate });
    } catch {
      audioCtx = new Ctor();
    }
    const srcRate = audioCtx.sampleRate;
    source = audioCtx.createMediaStreamSource(mediaStream);

    let usedWorklet = false;
    if (audioCtx.audioWorklet) {
      try {
        const blob = new Blob([WORKLET_SOURCE], { type: "application/javascript" });
        workletUrl = URL.createObjectURL(blob);
        await audioCtx.audioWorklet.addModule(workletUrl);
        workletNode = new AudioWorkletNode(audioCtx, WORKLET_NAME, {
          numberOfInputs: 1,
          numberOfOutputs: 0,
          channelCount: 1,
        });
        workletNode.port.onmessage = (e) => {
          handleFloat32(e.data as Float32Array, srcRate);
        };
        source.connect(workletNode);
        usedWorklet = true;
      } catch (err) {
        console.warn("[micCapture] AudioWorklet failed, falling back to ScriptProcessor", err);
      }
    }

    if (!usedWorklet) {
      // ScriptProcessorNode is deprecated but is the universal fallback.
      const bufSize = 4096;
      scriptNode = audioCtx.createScriptProcessor(bufSize, 1, 1);
      scriptNode.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        // Must copy: the underlying buffer is reused.
        handleFloat32(new Float32Array(input), srcRate);
      };
      source.connect(scriptNode);
      // Connect to a muted destination so the node actually runs.
      scriptNode.connect(audioCtx.destination);
    }

    running = true;
  };

  const stop = async () => {
    running = false;
    accumulator = new Float32Array(0);
    if (workletNode) {
      try {
        workletNode.port.onmessage = null;
        workletNode.disconnect();
      } catch {
        /* noop */
      }
      workletNode = null;
    }
    if (scriptNode) {
      try {
        scriptNode.onaudioprocess = null;
        scriptNode.disconnect();
      } catch {
        /* noop */
      }
      scriptNode = null;
    }
    if (source) {
      try {
        source.disconnect();
      } catch {
        /* noop */
      }
      source = null;
    }
    if (audioCtx) {
      try {
        await audioCtx.close();
      } catch {
        /* noop */
      }
      audioCtx = null;
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    }
    if (workletUrl) {
      URL.revokeObjectURL(workletUrl);
      workletUrl = null;
    }
  };

  const onAudioChunk = (cb: AudioChunkCallback) => {
    subscribers.add(cb);
    return () => subscribers.delete(cb);
  };

  const isRunning = () => running;

  return { start, stop, onAudioChunk, isRunning };
}
