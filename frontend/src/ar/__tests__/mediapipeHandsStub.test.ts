// Regression tests for the @mediapipe/hands → mediapipeHandsStub vite alias.
//
// Why this exists:
//   The real @mediapipe/hands package is an IIFE script with zero ES exports.
//   Strict ESM linkers fail at module load when hand-pose-detection's ESM
//   build does `import { Hands } from "@mediapipe/hands"`. We work around
//   it by aliasing the bare specifier to this stub. If anyone ever deletes
//   the alias or replaces the stub, these tests fire before the runtime
//   crash (which only surfaces when a user actually opens /ar in a browser).

import { describe, it, expect } from "vitest";
import * as stub from "@/ar/mediapipeHandsStub";

describe("mediapipeHandsStub — vite alias target for @mediapipe/hands", () => {
  it("exports a `Hands` binding so the static ESM import resolves", () => {
    // The exact value doesn't matter for tfjs-runtime users — what matters
    // is that the named export EXISTS (otherwise the linker crashes).
    expect("Hands" in stub).toBe(true);
  });

  it("exports HAND_CONNECTIONS as an iterable for symmetry with the real package", () => {
    expect(Array.isArray(stub.HAND_CONNECTIONS)).toBe(true);
  });

  it("exports a string VERSION marker that identifies this as the stub (not the real lib)", () => {
    expect(stub.VERSION).toBe("stub");
  });
});

describe("@mediapipe/hands bare-specifier resolves to our stub via vite alias", () => {
  it("imports cleanly without a 'binding name not found' linker error", async () => {
    // Vite's alias rewrites this bare specifier at build/dev time. If the
    // alias is removed, this dynamic import falls through to node_modules
    // and the IIFE-only package — which has no Hands export — surfaces a
    // "Importing binding name 'Hands' is not found" runtime error.
    const m = await import("@mediapipe/hands");
    expect(m).toBeDefined();
    expect("Hands" in m).toBe(true);
  });
});
