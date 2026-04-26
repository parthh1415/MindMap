import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "framer-motion";
import { useSessionStore } from "@/state/sessionStore";

/**
 * Realtime soundwave overlay shown while the mic is transcribing.
 *
 * Rationale: the topology agent runs every ~3 s of speech, so for the
 * first few seconds after the user hits Record there's nothing on the
 * canvas — orbs haven't spawned yet, the transcript stream may only
 * have a partial line. Without feedback the screen reads as broken.
 * The soundwave fills that gap with a clear "we hear you" signal that
 * tracks the user's actual voice in real time.
 *
 * Architecture:
 *   - Opens its OWN getUserMedia stream + AudioContext when `micActive`
 *     flips true. The browser merges this with the transcript pipeline's
 *     existing track on the same device (one prompt, one indicator), so
 *     the resource cost is just a second AnalyserNode tap.
 *   - 60-fps requestAnimationFrame loop reads `getByteFrequencyData()`
 *     and paints bars to a `<canvas>`. Pure direct-to-DOM rendering —
 *     no React re-renders during animation.
 *   - Cleans up audio + RAF on unmount or when micActive flips false.
 *
 * Reduced motion: replaces the animated bars with a single gentle
 * pulsing pill so the user still gets a "mic is live" affordance
 * without flickering motion.
 */
export function LiveSoundwave() {
  const micActive = useSessionStore((s) => s.micActive);
  const reduce = useReducedMotion();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // True after we successfully opened a stream — drives the entrance
  // fade-in so the chip doesn't pop in empty before audio arrives.
  const [audioReady, setAudioReady] = useState(false);

  useEffect(() => {
    if (!micActive) {
      setAudioReady(false);
      return;
    }
    if (reduce) {
      // Reduced-motion path: no audio loop, just show the pulsing pill.
      setAudioReady(true);
      return;
    }

    let cancelled = false;
    let rafId = 0;
    let stream: MediaStream | null = null;
    let audioCtx: AudioContext | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let analyser: AnalyserNode | null = null;

    const setup = async () => {
      try {
        if (!navigator?.mediaDevices?.getUserMedia) return;
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
          },
          video: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const Ctor: typeof AudioContext =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext;
        audioCtx = new Ctor();
        if (audioCtx.state === "suspended") {
          // micActive flipped after a user-gesture (mic-button click),
          // so resume succeeds without further prompting.
          try {
            await audioCtx.resume();
          } catch {
            /* ignore */
          }
        }
        source = audioCtx.createMediaStreamSource(stream);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 128; // 64 frequency bins — comfortable for ~32 bars
        analyser.smoothingTimeConstant = 0.78; // smoother bars, less jitter
        source.connect(analyser);
        if (cancelled) return;
        setAudioReady(true);
        loop();
      } catch (err) {
        // Likely permission denied or no mic. The transcript pipeline's
        // own error UI surfaces those — we just stay invisible.
        console.warn("[LiveSoundwave] audio tap unavailable:", err);
      }
    };

    const loop = () => {
      if (cancelled) return;
      const canvas = canvasRef.current;
      const a = analyser;
      if (canvas && a) {
        const bins = a.frequencyBinCount;
        const data = new Uint8Array(bins);
        a.getByteFrequencyData(data);
        drawRadialBars(canvas, data);
      }
      rafId = window.requestAnimationFrame(loop);
    };

    void setup();

    return () => {
      cancelled = true;
      if (rafId) window.cancelAnimationFrame(rafId);
      try {
        source?.disconnect();
      } catch {
        /* ignore */
      }
      try {
        analyser?.disconnect();
      } catch {
        /* ignore */
      }
      try {
        stream?.getTracks().forEach((t) => t.stop());
      } catch {
        /* ignore */
      }
      try {
        void audioCtx?.close();
      } catch {
        /* ignore */
      }
    };
  }, [micActive, reduce]);

  if (!micActive) return null;

  return (
    <div
      className={`live-soundwave${audioReady ? " is-ready" : ""}`}
      role="status"
      aria-label="Listening to microphone"
      aria-live="polite"
    >
      {reduce ? (
        <div className="live-soundwave__pulse" aria-hidden>
          <span className="live-soundwave__core" />
          <span className="live-soundwave__pulse-label">Listening</span>
        </div>
      ) : (
        <div className="live-soundwave__orb" aria-hidden>
          <canvas
            ref={canvasRef}
            className="live-soundwave__canvas"
            width={280}
            height={280}
          />
          <span className="live-soundwave__core" />
        </div>
      )}
      <span className="live-soundwave__label" aria-hidden>
        Listening · orbs spawn every few seconds
      </span>

      <style>{`
        /* Circular "Siri-style" listening orb — centered to the viewport,
           no rectangular chrome. The visualizer IS the visual: radial
           bars on a transparent canvas with a glowing core, plus a soft
           glassmorphic halo behind so it reads against the dark canvas
           even when the user isn't speaking. Stays out of the way of
           the transcript stream below at any size. */
        .live-soundwave {
          position: absolute;
          left: 50%;
          top: 50%;
          transform: translate(-50%, -50%);
          z-index: 24;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 16px;
          opacity: 0;
          transition: opacity 280ms ease-out;
          pointer-events: none;
        }
        .live-soundwave.is-ready { opacity: 1; }

        .live-soundwave__orb {
          position: relative;
          width: 280px;
          height: 280px;
          display: grid;
          place-items: center;
        }
        /* Soft halo behind the bars — pure CSS, no per-frame work. The
           radial gradient + blur reads as ambient stage lighting. */
        .live-soundwave__orb::before {
          content: "";
          position: absolute;
          inset: 0;
          border-radius: 999px;
          background: radial-gradient(
            circle at 50% 50%,
            rgba(214, 255, 58, 0.18) 0%,
            rgba(214, 255, 58, 0.08) 35%,
            rgba(12, 18, 25, 0.55) 60%,
            rgba(12, 18, 25, 0.0) 78%
          );
          filter: blur(2px);
          pointer-events: none;
        }
        /* Subtle outer ring — anchors the orb visually against the
           ambient gradient so it doesn't look like it's floating. */
        .live-soundwave__orb::after {
          content: "";
          position: absolute;
          inset: 22px;
          border-radius: 999px;
          border: 1px solid rgba(214, 255, 58, 0.10);
          pointer-events: none;
        }

        .live-soundwave__canvas {
          position: relative;
          z-index: 1;
          width: 280px;
          height: 280px;
          display: block;
        }

        /* Center "core" — the heart of the orb. Slow breathing pulse so
           even during silence the user sees a living signal. */
        .live-soundwave__core {
          position: absolute;
          width: 18px;
          height: 18px;
          border-radius: 999px;
          background: radial-gradient(
            circle at 35% 30%,
            #ffffff 0%,
            var(--signature-accent) 55%,
            color-mix(in srgb, var(--signature-accent) 65%, #000) 100%
          );
          box-shadow:
            0 0 14px var(--signature-accent-glow),
            0 0 32px rgba(214, 255, 58, 0.35);
          z-index: 2;
          animation: live-soundwave-core 2.2s ease-in-out infinite;
        }
        @keyframes live-soundwave-core {
          0%, 100% { transform: scale(1);    opacity: 0.92; }
          50%      { transform: scale(1.15); opacity: 1;    }
        }

        .live-soundwave__label {
          font-family: var(--font-display);
          font-size: 10.5px;
          letter-spacing: 0.18em;
          font-weight: 600;
          text-transform: uppercase;
          color: var(--text-tertiary);
          white-space: nowrap;
        }

        /* Reduced-motion variant: a quiet glowing dot, no animation. */
        .live-soundwave__pulse {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 10px;
        }
        .live-soundwave__pulse-label {
          font-family: var(--font-display);
          font-size: 11px;
          letter-spacing: 0.14em;
          font-weight: 600;
          text-transform: uppercase;
          color: var(--text-secondary);
        }

        @media (max-width: 640px) {
          .live-soundwave__orb,
          .live-soundwave__canvas { width: 220px; height: 220px; }
        }

        @media (prefers-reduced-motion: reduce) {
          .live-soundwave__core { animation: none; opacity: 0.9; }
        }
      `}</style>
    </div>
  );
}

/**
 * Paint frequency-domain magnitudes as RADIAL bars — each bar grows
 * outward from a fixed inner radius around the canvas center. The
 * effect is a Siri-style listening orb that reacts to the user's
 * voice in 360° around its center, matching the project's circular
 * orb aesthetic rather than reading as a rectangular EQ.
 */
function drawRadialBars(canvas: HTMLCanvasElement, data: Uint8Array): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const cx = w / 2;
  const cy = h / 2;
  // Inner radius of the bar ring — leaves room for the glowing center
  // core (rendered as a CSS sibling). Outer extends most of the way
  // toward the canvas edge so loud sounds give a satisfying bloom.
  const innerR = Math.min(w, h) * 0.18;
  const maxBar = Math.min(w, h) * 0.34;

  // Lower 75% of bins — top frequencies are mic noise and would just
  // add noise to the bars closest to the start angle.
  const usable = Math.floor(data.length * 0.75);
  const barCount = 64; // plenty of resolution at 280px without crowding
  const stride = Math.max(1, Math.floor(usable / barCount));

  // Volt-yellow with a soft glow.
  ctx.lineCap = "round";
  ctx.strokeStyle = "#d6ff3a";
  ctx.shadowColor = "rgba(214, 255, 58, 0.55)";
  ctx.shadowBlur = 8;
  ctx.lineWidth = 2.4;

  for (let i = 0; i < barCount; i++) {
    // Average a small window of bins so neighbouring bars feel cohesive.
    let sum = 0;
    const base = i * stride;
    for (let j = 0; j < stride; j++) sum += data[base + j] ?? 0;
    const avg = sum / stride;
    // sqrt curve so quiet speech still moves the visual.
    const norm = Math.sqrt(avg / 255);
    const length = Math.max(2, norm * maxBar);

    const angle = (i / barCount) * Math.PI * 2 - Math.PI / 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    const x1 = cx + cos * innerR;
    const y1 = cy + sin * innerR;
    const x2 = cx + cos * (innerR + length);
    const y2 = cy + sin * (innerR + length);

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  // Faint baseline ring at the inner radius so the orb has shape even
  // during silence. Drawn after the bars so it sits above any bars
  // that didn't move (visual anchor).
  ctx.shadowBlur = 0;
  ctx.strokeStyle = "rgba(214, 255, 58, 0.20)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, innerR - 1, 0, Math.PI * 2);
  ctx.stroke();
}

export default LiveSoundwave;
