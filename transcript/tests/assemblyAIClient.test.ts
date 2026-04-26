// Tests for assemblyAIClient — message parsing, dominant-speaker
// extraction, close-code classification. Pure helpers only — no live
// WebSocket / network. The test seam (`__test__`) exposes everything
// we need.

import { describe, it, expect } from "vitest";
import { __test__ } from "../client/assemblyAIClient";

const { parseAssemblyMessage, dominantSpeakerOfTurn, classifyClose, DEFAULT_ENDPOINT } = __test__;

describe("dominantSpeakerOfTurn", () => {
  it("returns 'speaker_default' for empty word lists", () => {
    expect(dominantSpeakerOfTurn(undefined)).toBe("speaker_default");
    expect(dominantSpeakerOfTurn([])).toBe("speaker_default");
  });

  it("returns 'speaker_default' when no word carries a speaker label", () => {
    expect(
      dominantSpeakerOfTurn([
        { speaker: null },
        { speaker: undefined },
        {} as { speaker?: string | number | null },
      ]),
    ).toBe("speaker_default");
  });

  it("returns the most-common speaker tag", () => {
    expect(
      dominantSpeakerOfTurn([
        { speaker: "A" },
        { speaker: "A" },
        { speaker: "B" },
      ]),
    ).toBe("speaker_A");
  });

  it("normalizes numeric speaker ids", () => {
    expect(
      dominantSpeakerOfTurn([
        { speaker: 0 },
        { speaker: 0 },
        { speaker: 1 },
      ]),
    ).toBe("speaker_0");
  });
});

describe("parseAssemblyMessage", () => {
  it("returns null for non-objects + non-transcription types", () => {
    expect(parseAssemblyMessage(null, "s1")).toBeNull();
    expect(parseAssemblyMessage("str", "s1")).toBeNull();
    expect(parseAssemblyMessage({ type: "Begin", id: "x" }, "s1")).toBeNull();
    expect(parseAssemblyMessage({ type: "Termination" }, "s1")).toBeNull();
  });

  it("parses a v3 Turn (partial) into a TranscriptChunk", () => {
    const out = parseAssemblyMessage(
      {
        type: "Turn",
        transcript: "hello world",
        end_of_turn: false,
        words: [{ speaker: "A" }, { speaker: "A" }],
      },
      "sess-42",
    );
    expect(out).not.toBeNull();
    expect(out!.type).toBe("transcript");
    expect(out!.session_id).toBe("sess-42");
    expect(out!.text).toBe("hello world");
    expect(out!.is_final).toBe(false);
    expect(out!.speaker_id).toBe("speaker_A");
  });

  it("parses a v3 Turn (final via end_of_turn=true)", () => {
    const out = parseAssemblyMessage(
      {
        type: "Turn",
        transcript: "ok done",
        end_of_turn: true,
        words: [{ speaker: 0 }],
      },
      "s",
    );
    expect(out!.is_final).toBe(true);
    expect(out!.speaker_id).toBe("speaker_0");
  });

  it("supports legacy v2 PartialTranscript / FinalTranscript shapes", () => {
    const partial = parseAssemblyMessage(
      { type: "PartialTranscript", text: "ab", words: [] },
      "s",
    );
    expect(partial!.is_final).toBe(false);
    expect(partial!.text).toBe("ab");

    const final = parseAssemblyMessage(
      { type: "FinalTranscript", text: "abc.", words: [{ speaker: "B" }] },
      "s",
    );
    expect(final!.is_final).toBe(true);
    expect(final!.speaker_id).toBe("speaker_B");
  });

  it("skips empty / whitespace-only transcripts", () => {
    expect(
      parseAssemblyMessage(
        { type: "Turn", transcript: "", end_of_turn: false },
        "s",
      ),
    ).toBeNull();
    expect(
      parseAssemblyMessage(
        { type: "Turn", transcript: "   ", end_of_turn: false },
        "s",
      ),
    ).toBeNull();
  });

  it("falls back to speaker_default when words array missing", () => {
    const out = parseAssemblyMessage(
      { type: "Turn", transcript: "no words", end_of_turn: true },
      "s",
    );
    expect(out!.speaker_id).toBe("speaker_default");
  });
});

describe("classifyClose", () => {
  it("flags 4001/4003 + auth-keyword reasons as auth", () => {
    expect(classifyClose(4001, "")).toBe("auth");
    expect(classifyClose(4003, "")).toBe("auth");
    expect(classifyClose(1008, "unauthorized")).toBe("auth");
    expect(classifyClose(1008, "Invalid token")).toBe("auth");
  });

  it("flags 4002/4029 + credit-keyword reasons as credit", () => {
    expect(classifyClose(4002, "")).toBe("credit");
    expect(classifyClose(4029, "quota")).toBe("credit");
    expect(classifyClose(1008, "credit limit")).toBe("credit");
  });

  it("classifies 1006/1011 as network", () => {
    expect(classifyClose(1006, "")).toBe("network");
    expect(classifyClose(1011, "server error")).toBe("network");
  });

  it("returns unknown by default", () => {
    expect(classifyClose(1000, "normal closure")).toBe("unknown");
  });
});

describe("DEFAULT_ENDPOINT", () => {
  it("points at AssemblyAI v3 streaming", () => {
    expect(DEFAULT_ENDPOINT).toBe("wss://streaming.assemblyai.com/v3/ws");
  });
});

describe("createSpeakerResolver — stable IDs across the session", () => {
  const { createSpeakerResolver } = __test__;

  it("assigns speaker_0, speaker_1, … in order of first appearance", () => {
    const r = createSpeakerResolver();
    // First final turn — raw label "B" speaks first, gets speaker_0.
    const first = r.resolve(
      [{ speaker: "B" }, { speaker: "B" }, { speaker: "B" }, { speaker: "B" }],
      true,
    );
    expect(first).toBe("speaker_0");
    // Next turn — raw label "A" appears, becomes speaker_1.
    const second = r.resolve(
      [{ speaker: "A" }, { speaker: "A" }, { speaker: "A" }, { speaker: "A" }],
      true,
    );
    expect(second).toBe("speaker_1");
    // "B" returns — must keep speaker_0 even though chronologically later.
    const third = r.resolve(
      [{ speaker: "B" }, { speaker: "B" }, { speaker: "B" }, { speaker: "B" }],
      true,
    );
    expect(third).toBe("speaker_0");
  });

  it("sticks to previous speaker on a short interjection from an ALREADY-KNOWN speaker", () => {
    const r = createSpeakerResolver();
    // Establish A and B as known speakers first — both have committed.
    r.resolve(
      [{ speaker: "A" }, { speaker: "A" }, { speaker: "A" }, { speaker: "A" }, { speaker: "A" }],
      true,
    ); // speaker_0 = A
    r.resolve(
      [{ speaker: "B" }, { speaker: "B" }, { speaker: "B" }, { speaker: "B" }, { speaker: "B" }],
      true,
    ); // speaker_1 = B; lastFinalSpeaker = speaker_1
    // Now a 2-word interjection mislabelled as A (which IS in the
    // idMap). Stickiness applies → stays on speaker_1.
    const out = r.resolve([{ speaker: "A" }, { speaker: "A" }], true);
    expect(out).toBe("speaker_1");
  });

  it("commits a brand-new speaker even on a short turn (multi-speaker capture)", () => {
    const r = createSpeakerResolver();
    r.resolve(
      [{ speaker: "A" }, { speaker: "A" }, { speaker: "A" }, { speaker: "A" }, { speaker: "A" }],
      true,
    ); // anchor A as speaker_0
    // Two-word turn from a BRAND-NEW raw label C. Suppressing this would
    // cap the conversation at A forever; the resolver must register
    // never-before-seen labels eagerly so 3rd / 4th / Nth speakers can
    // be detected without waiting for a long turn.
    const out = r.resolve([{ speaker: "C" }, { speaker: "C" }], true);
    expect(out).toBe("speaker_1");
  });

  it("sticks on a contested turn between TWO already-known speakers", () => {
    const r = createSpeakerResolver();
    // Pre-establish both A and B.
    r.resolve(
      [{ speaker: "A" }, { speaker: "A" }, { speaker: "A" }, { speaker: "A" }],
      true,
    );
    r.resolve(
      [{ speaker: "B" }, { speaker: "B" }, { speaker: "B" }, { speaker: "B" }],
      true,
    ); // lastFinalSpeaker = speaker_1
    // 5/9 ≈ 0.56 split, both labels already known → contested gate fires
    // → stays on speaker_1.
    const out = r.resolve(
      [
        { speaker: "A" }, { speaker: "A" }, { speaker: "A" },
        { speaker: "A" }, { speaker: "A" },
        { speaker: "B" }, { speaker: "B" }, { speaker: "B" }, { speaker: "B" },
      ],
      true,
    );
    expect(out).toBe("speaker_1");
  });

  it("commits a clear majority of ≥60%", () => {
    const r = createSpeakerResolver();
    r.resolve(
      [{ speaker: "A" }, { speaker: "A" }, { speaker: "A" }, { speaker: "A" }],
      true,
    ); // speaker_0 = A
    // 7 vs 3 = 70% B → switch to a new stable id.
    const out = r.resolve(
      [
        { speaker: "B" }, { speaker: "B" }, { speaker: "B" },
        { speaker: "B" }, { speaker: "B" }, { speaker: "B" }, { speaker: "B" },
        { speaker: "A" }, { speaker: "A" }, { speaker: "A" },
      ],
      true,
    );
    expect(out).toBe("speaker_1");
  });

  it("partial turns do NOT update the sticky anchor", () => {
    const r = createSpeakerResolver();
    r.resolve(
      [{ speaker: "A" }, { speaker: "A" }, { speaker: "A" }, { speaker: "A" }],
      true,
    ); // anchor A as speaker_0
    // Partial turn with B clearly dominant — resolver returns the B's
    // stable id but does NOT commit it (state would otherwise pin to B).
    r.resolve(
      [{ speaker: "B" }, { speaker: "B" }, { speaker: "B" }, { speaker: "B" }, { speaker: "B" }],
      false,
    );
    expect(r.state().lastFinalSpeaker).toBe("speaker_0");
  });

  it("first-ever turn commits even if short", () => {
    const r = createSpeakerResolver();
    // No previous anchor → must commit something rather than fall back
    // to "speaker_default" forever.
    const out = r.resolve([{ speaker: "A" }], true);
    expect(out).toBe("speaker_0");
  });
});
