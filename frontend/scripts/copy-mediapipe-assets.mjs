// Copies @mediapipe/hands solution files into public/mediapipe/hands so
// hand-pose-detection's `solutionPath` resolves at runtime in both dev
// and prod. Runs as a postinstall + prebuild step.
import { mkdirSync, copyFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const src = "node_modules/@mediapipe/hands";
const dst = "public/mediapipe/hands";

if (!existsSync(src)) {
  console.warn("[copy-mediapipe-assets] source missing — skipping (deps not installed yet)");
  process.exit(0);
}
mkdirSync(dst, { recursive: true });
for (const file of readdirSync(src)) {
  if (/\.(wasm|binarypb|js|data|tflite)$/.test(file)) {
    copyFileSync(join(src, file), join(dst, file));
  }
}
console.log("[copy-mediapipe-assets] copied to", dst);
