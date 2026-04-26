import { defineConfig, type UserConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const config: UserConfig & { test?: unknown } = {
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@shared": path.resolve(__dirname, "..", "shared"),
      "@mindmap/transcript-client": path.resolve(
        __dirname,
        "..",
        "transcript",
        "client",
        "index.ts",
      ),
      // @tensorflow-models/hand-pose-detection's ESM build statically
      // imports { Hands } from "@mediapipe/hands", but the real package
      // is an IIFE with zero ES exports — strict ESM linking fails. We
      // use runtime: "tfjs" so the imported binding is dead code; this
      // stub just makes the import resolve.
      "@mediapipe/hands": path.resolve(
        __dirname,
        "src",
        "ar",
        "mediapipeHandsStub.ts",
      ),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
  optimizeDeps: {
    // Force-include the tfjs deps so vite's esbuild converts them through
    // its CJS interop layer. Serving them raw causes Safari (strictest
    // ESM impl) to throw "Can't find variable: module" because the deep
    // tfjs/converter dependency tree contains UMD-wrapped helpers.
    include: [
      "@tensorflow/tfjs-core",
      "@tensorflow/tfjs-converter",
      "@tensorflow/tfjs-backend-webgl",
    ],
    // EXCLUDE hand-pose-detection from prebundle on purpose. Esbuild's
    // resolver doesn't honor vite's resolve.alias for nested bare
    // imports during prebundle, so it would drop the
    // `import { Hands } from "@mediapipe/hands"` line entirely
    // (the real package is an IIFE with zero exports — esbuild
    // tree-shakes it to nothing). At runtime that surfaces as
    // 'undefined is not a constructor' when hand-pose-detection's
    // mediapipe runtime tries `new Hands(config)`.
    //
    // Excluding it makes vite serve hand-pose-detection.esm.js raw —
    // the dev-server's module-import rewriter DOES apply
    // resolve.alias, so `@mediapipe/hands` correctly resolves to our
    // mediapipeHandsStub.ts (Proxy → window.Hands).
    exclude: [
      "@tensorflow/tfjs-backend-wasm",
      "@tensorflow-models/hand-pose-detection",
    ],
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
  },
};

// https://vite.dev/config/
export default defineConfig(config);
