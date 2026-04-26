// Regression test: enforce that initDetector uses runtime: "mediapipe"
// with a local solutionPath. The friend's reference spec calls for the
// MediaPipe runtime explicitly — it's faster and more accurate than the
// tfjs runtime, and uses local assets we vendor in public/mediapipe/hands/
// (no TFHub model download at runtime).
//
// Switching back to "tfjs" or omitting solutionPath would silently
// degrade tracking quality and require network for model fetch — this
// test fires LOUDLY if anyone changes that.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const handTrackingPath = resolve(__dirname, "..", "handTracking.ts");

describe("initDetector runtime contract", () => {
  const src = readFileSync(handTrackingPath, "utf-8");

  it("uses runtime: \"mediapipe\" (per friend's reference spec)", () => {
    expect(src).toMatch(/runtime:\s*"mediapipe"/);
  });

  it("does NOT use runtime: \"tfjs\" (slow + needs TFHub network fetch)", () => {
    expect(src).not.toMatch(/runtime:\s*"tfjs"/);
  });

  it("passes solutionPath pointing at the local /mediapipe/hands assets", () => {
    expect(src).toMatch(/solutionPath:\s*`\$\{window\.location\.origin\}\/mediapipe\/hands`/);
  });

  it("injects /mediapipe/hands/hands.js as a <script> before createDetector", () => {
    expect(src).toMatch(/loadMediaPipeHandsScript/);
    expect(src).toMatch(/\/mediapipe\/hands\/hands\.js/);
  });

  it("awaits tf.ready() (createDetector needs tfjs-core initialized)", () => {
    expect(src).toMatch(/await\s+tf\.ready\(\)/);
  });

  it("memoizes the script-load promise so we don't inject the IIFE twice", () => {
    expect(src).toMatch(/mediapipeScriptLoadPromise/);
  });
});
