/**
 * Optional Web Audio click cue for node creation/merge events.
 *
 * Off by default. Toggled via the sound icon in TopBar (writes to
 * sessionStore.soundEnabled). Resilient to AudioContext autoplay policies
 * — first call lazily creates the context after a user gesture.
 */

let ctx: AudioContext | null = null;

function ensureCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    try {
      ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    } catch {
      return null;
    }
  }
  return ctx;
}

export function playClick(opts: { freq?: number; volume?: number } = {}): void {
  const c = ensureCtx();
  if (!c) return;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = "sine";
  osc.frequency.value = opts.freq ?? 880;
  const vol = opts.volume ?? 0.04;
  gain.gain.setValueAtTime(0, c.currentTime);
  gain.gain.linearRampToValueAtTime(vol, c.currentTime + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.18);
  osc.connect(gain).connect(c.destination);
  osc.start();
  osc.stop(c.currentTime + 0.2);
}
