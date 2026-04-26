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
