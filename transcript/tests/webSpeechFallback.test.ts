// Tests for webSpeechFallback restartGuard. We install a mock
// SpeechRecognition that lets us trigger onend at will and assert that
// start() is invoked again while the fallback is active.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

interface RecogStub {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  onresult: ((e: unknown) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onend: ((e: unknown) => void) | null;
  onstart: ((e: unknown) => void) | null;
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives?: number;
}

const stubs: RecogStub[] = [];

class MockSpeechRecognition {
  start = vi.fn();
  stop = vi.fn();
  abort = vi.fn();
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onend: ((e: unknown) => void) | null = null;
  onstart: ((e: unknown) => void) | null = null;
  continuous = false;
  interimResults = false;
  lang = "";
  maxAlternatives = 1;

  constructor() {
    stubs.push(this as unknown as RecogStub);
  }
}

beforeEach(() => {
  stubs.length = 0;
  vi.stubGlobal("SpeechRecognition", MockSpeechRecognition);
  // sessionStorage is provided by jsdom; clear it.
  try {
    sessionStorage.clear();
  } catch {
    /* noop */
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("webSpeechFallback restartGuard", () => {
  it("auto-restarts after onend while active", async () => {
    const { createWebSpeechFallback } = await import("../client/webSpeechFallback");
    const fb = createWebSpeechFallback({ sessionId: "s1" });
    fb.start();
    expect(stubs).toHaveLength(1);
    expect(stubs[0]!.start).toHaveBeenCalledTimes(1);

    // Fire onend; the restart guard should call start() again after a tick.
    stubs[0]!.onend?.(new Event("end"));
    await new Promise((r) => setTimeout(r, 100));
    expect(stubs[0]!.start).toHaveBeenCalledTimes(2);

    fb.stop();
  });

  it("does NOT restart after stop()", async () => {
    const { createWebSpeechFallback } = await import("../client/webSpeechFallback");
    const fb = createWebSpeechFallback({ sessionId: "s2" });
    fb.start();
    const recog = stubs[0]!;
    fb.stop();
    // Even if the browser fires onend (the underlying API does this on .stop()),
    // we should NOT re-start because active=false.
    recog.onend?.(new Event("end"));
    await new Promise((r) => setTimeout(r, 100));
    expect(recog.start).toHaveBeenCalledTimes(1);
  });

  it("emits TranscriptChunk objects with the stable speaker_id", async () => {
    const { createWebSpeechFallback } = await import("../client/webSpeechFallback");
    const fb = createWebSpeechFallback({ sessionId: "s3" });
    const got: Array<{ speaker_id: string; text: string; is_final: boolean }> = [];
    fb.onChunk((c) =>
      got.push({ speaker_id: c.speaker_id, text: c.text, is_final: c.is_final }),
    );
    fb.start();
    const recog = stubs[0]!;

    recog.onresult?.({
      resultIndex: 0,
      results: {
        length: 1,
        0: { isFinal: false, length: 1, 0: { transcript: "hello" } },
      },
    });
    recog.onresult?.({
      resultIndex: 0,
      results: {
        length: 1,
        0: { isFinal: true, length: 1, 0: { transcript: "hello world" } },
      },
    });

    expect(got).toHaveLength(2);
    expect(got[0]!.is_final).toBe(false);
    expect(got[1]!.is_final).toBe(true);
    expect(got[0]!.speaker_id).toBe(got[1]!.speaker_id);
    expect(got[0]!.speaker_id).toMatch(/^speaker_/);
    expect(got[0]!.speaker_id).toBe(fb.getSpeakerId());

    fb.stop();
  });
});
