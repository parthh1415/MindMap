// Tests for diarizeUploader — pure helpers only (no actual fetch / timers).

import { describe, it, expect } from "vitest";
import { __test__ } from "../client/diarizeUploader";

const { buildWavBuffer, appendChunk, defaultUploadUrl } = __test__;

describe("appendChunk", () => {
  it("returns a new Int16Array containing buffer + chunk", () => {
    const a = new Int16Array([1, 2, 3]);
    const b = new Int16Array([4, 5]);
    const out = appendChunk(a, b);
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5]);
  });

  it("handles empty buffers without throwing", () => {
    const empty = new Int16Array(0);
    const out = appendChunk(empty, new Int16Array([7]));
    expect(Array.from(out)).toEqual([7]);
  });
});

describe("buildWavBuffer", () => {
  it("produces a 44-byte header followed by little-endian samples", () => {
    const samples = new Int16Array([0, 32767, -32768, 1234]);
    const buf = buildWavBuffer(samples, 16000);
    const view = new DataView(buf);

    // RIFF / WAVE / fmt / data magic
    const ascii = (off: number, len: number) =>
      Array.from({ length: len }, (_, i) => String.fromCharCode(view.getUint8(off + i))).join("");
    expect(ascii(0, 4)).toBe("RIFF");
    expect(ascii(8, 4)).toBe("WAVE");
    expect(ascii(12, 4)).toBe("fmt ");
    expect(ascii(36, 4)).toBe("data");

    // sample rate = 16000, mono, 16-bit
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint16(34, true)).toBe(16);

    // data chunk size = 4 samples × 2 bytes = 8 bytes
    expect(view.getUint32(40, true)).toBe(8);

    // first sample is 0
    expect(view.getInt16(44, true)).toBe(0);
    // second sample is 32767 (max int16)
    expect(view.getInt16(46, true)).toBe(32767);
    // third sample is -32768 (min int16)
    expect(view.getInt16(48, true)).toBe(-32768);
  });
});

describe("defaultUploadUrl", () => {
  it("attaches session_id as a URL-safe query param", () => {
    const url = defaultUploadUrl("session abc/123");
    // Spaces and slashes get encoded.
    expect(url).toContain("session_id=session%20abc%2F123");
    expect(url).toMatch(/\/internal\/diarize-batch\?/);
  });
});
