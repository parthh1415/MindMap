import { defineConfig } from "vite";

// Minimal Vite config so the demo can run via `npx vite serve transcript`.
// Inherits the repo's .env (looking for VITE_ELEVENLABS_API_KEY etc.).
export default defineConfig({
  root: __dirname,
  envDir: "..",
  server: {
    port: 5173,
    host: true,
  },
  build: {
    target: "es2022",
    outDir: "dist",
  },
});
