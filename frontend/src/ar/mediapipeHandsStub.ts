// Empty ESM stub aliased to "@mediapipe/hands" via vite.config.ts.
//
// `@tensorflow-models/hand-pose-detection`'s ESM build does a STATIC
// `import { Hands } from "@mediapipe/hands"` at the top of the bundle.
// The real @mediapipe/hands package is an IIFE script with zero ES
// exports — it registers `Hands` on `window` via Closure Library's
// goog.exportSymbol. The strict ESM linker fails before any of our
// code runs.
//
// We use the tfjs runtime (not mediapipe), so the imported `Hands`
// reference is dead code at runtime. The stub just makes the static
// import resolve cleanly.

export const Hands: unknown = undefined;
export const HAND_CONNECTIONS: ReadonlyArray<[number, number]> = [];
export const VERSION = "stub";
