// Regression test: enforce that initDetector uses runtime: "tfjs", NOT
// "mediapipe". Switching to "mediapipe" would crash the /ar route at
// module-load time because the @mediapipe/hands ESM stub (used to satisfy
// hand-pose-detection's static import) doesn't have a real Hands constructor.
//
// This test reads the source of handTracking.ts as text and asserts the
// runtime literal. It's brittle by design — it should fire LOUDLY if
// anyone changes this without understanding the constraint.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const handTrackingPath = resolve(__dirname, "..", "handTracking.ts");

describe("initDetector runtime contract", () => {
  const src = readFileSync(handTrackingPath, "utf-8");

  it("uses runtime: \"tfjs\"", () => {
    expect(src).toMatch(/runtime:\s*"tfjs"/);
  });

  it("does NOT use runtime: \"mediapipe\" (would crash on /ar load)", () => {
    expect(src).not.toMatch(/runtime:\s*"mediapipe"/);
  });

  it("does NOT pass solutionPath (only needed by mediapipe runtime)", () => {
    expect(src).not.toMatch(/solutionPath:/);
  });

  it("imports tfjs-backend-webgl (peer dep for tfjs runtime)", () => {
    expect(src).toMatch(/@tensorflow\/tfjs-backend-webgl/);
  });

  it("calls tf.setBackend(\"webgl\")", () => {
    expect(src).toMatch(/setBackend\(\s*"webgl"\s*\)/);
  });
});
