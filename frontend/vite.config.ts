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
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
  },
};

// https://vite.dev/config/
export default defineConfig(config);
