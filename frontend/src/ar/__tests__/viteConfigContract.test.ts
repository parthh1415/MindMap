// Regression test for the @mediapipe/hands alias plumbing.
//
// Two things must stay true at the vite-config level:
//   1. resolve.alias maps "@mediapipe/hands" → src/ar/mediapipeHandsStub.ts
//   2. optimizeDeps does NOT include @tensorflow-models/hand-pose-detection
//
// The combo matters: if hand-pose-detection is in optimizeDeps.include,
// esbuild's prebundle resolver doesn't honor vite's resolve.alias for
// nested bare imports. It tree-shakes the import, leaving the bundle
// with `new undefined(config)` at runtime — Safari surfaces that as
// "undefined is not a constructor".
//
// The fix: keep tfjs deps in include (they need esbuild's CJS interop),
// but exclude hand-pose-detection so vite's dev-server module rewriter
// applies the alias when it serves hand-pose-detection.esm.js raw.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const viteConfigPath = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "vite.config.ts",
);

describe("vite.config.ts AR alias contract", () => {
  const src = readFileSync(viteConfigPath, "utf-8");

  it("aliases @mediapipe/hands to mediapipeHandsStub.ts", () => {
    expect(src).toMatch(/"@mediapipe\/hands"/);
    expect(src).toMatch(/mediapipeHandsStub/);
    // Same statement: alias key on a line that also references the stub
    // path, OR within the same `alias: { ... }` block.
    expect(src).toMatch(/"@mediapipe\/hands":\s*path\.resolve\([^)]*"mediapipeHandsStub\.ts"/s);
  });

  it("EXCLUDES @tensorflow-models/hand-pose-detection from optimizeDeps", () => {
    // Must appear in exclude, NOT in include.
    const excludeBlock = src.match(/exclude:\s*\[([^\]]+)\]/s);
    expect(excludeBlock, "optimizeDeps.exclude block missing").not.toBeNull();
    expect(excludeBlock![1]).toMatch(
      /@tensorflow-models\/hand-pose-detection/,
    );
  });

  it("does NOT include @tensorflow-models/hand-pose-detection in optimizeDeps.include", () => {
    const includeBlock = src.match(/include:\s*\[([^\]]+)\]/s);
    if (includeBlock) {
      expect(includeBlock[1]).not.toMatch(
        /@tensorflow-models\/hand-pose-detection/,
      );
    }
  });

  it("INCLUDES the tfjs deps (they need esbuild CJS interop for Safari)", () => {
    const includeBlock = src.match(/include:\s*\[([^\]]+)\]/s);
    expect(includeBlock, "optimizeDeps.include block missing").not.toBeNull();
    expect(includeBlock![1]).toMatch(/@tensorflow\/tfjs-core/);
    expect(includeBlock![1]).toMatch(/@tensorflow\/tfjs-converter/);
    expect(includeBlock![1]).toMatch(/@tensorflow\/tfjs-backend-webgl/);
  });

  it("EXCLUDES tfjs-backend-wasm (ships its own .wasm assets, breaks if prebundled)", () => {
    const excludeBlock = src.match(/exclude:\s*\[([^\]]+)\]/s);
    expect(excludeBlock).not.toBeNull();
    expect(excludeBlock![1]).toMatch(/@tensorflow\/tfjs-backend-wasm/);
  });
});
