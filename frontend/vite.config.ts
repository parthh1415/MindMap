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
    },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
  optimizeDeps: {
    exclude: [
      "@tensorflow/tfjs-backend-wasm",
      "@mediapipe/hands",
      "@tensorflow-models/hand-pose-detection",
    ],
  },
  build: {
    rollupOptions: {
      // @mediapipe/hands ships as a browser global script (not a proper ESM
      // package). It loads itself from solutionPath at runtime — there is no
      // bundle-time import to resolve. Mark it external so rolldown doesn't
      // try to parse its non-ESM exports.
      external: ["@mediapipe/hands"],
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
  },
};

// https://vite.dev/config/
export default defineConfig(config);
