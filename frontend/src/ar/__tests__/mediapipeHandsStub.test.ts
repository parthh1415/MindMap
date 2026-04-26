// Regression tests for the @mediapipe/hands → mediapipeHandsStub vite alias.
//
// The stub exports lazy Proxies that forward `new Hands(...)` and
// `HAND_CONNECTIONS` to `window.Hands` / `window.HAND_CONNECTIONS` —
// which are installed at runtime by /mediapipe/hands/hands.js (an IIFE
// loaded as a <script> tag inside initDetector before createDetector
// runs).
//
// These tests verify the vite alias is wired AND the Proxies forward
// correctly when the globals are present. Without the alias, the
// `import { Hands } from "@mediapipe/hands"` static import in
// hand-pose-detection's ESM build would crash at module-load with
// "Importing binding name 'Hands' is not found".

import { describe, it, expect, beforeEach, afterEach } from "vitest";

describe("@mediapipe/hands bare-specifier resolves to our stub via vite alias", () => {
  it("imports cleanly without a 'binding name not found' linker error", async () => {
    const m = await import("@mediapipe/hands");
    expect(m).toBeDefined();
    expect("Hands" in m).toBe(true);
    expect("HAND_CONNECTIONS" in m).toBe(true);
  });
});

describe("mediapipeHandsStub Proxy behavior", () => {
  beforeEach(() => {
    // Reset window globals to a known state
    delete (window as unknown as Record<string, unknown>).Hands;
    delete (window as unknown as Record<string, unknown>).HAND_CONNECTIONS;
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).Hands;
    delete (window as unknown as Record<string, unknown>).HAND_CONNECTIONS;
  });

  it("`new Hands(config)` throws a clear error when window.Hands isn't loaded", async () => {
    const { Hands } = await import("@mediapipe/hands");
    expect(() => new (Hands as new (cfg: unknown) => unknown)({})).toThrow(
      /not loaded/,
    );
  });

  it("`new Hands(config)` forwards to window.Hands once the IIFE has installed it", async () => {
    const captured: unknown[] = [];
    class FakeHands {
      constructor(cfg: unknown) {
        captured.push(cfg);
      }
    }
    (window as unknown as Record<string, unknown>).Hands = FakeHands;

    const { Hands } = await import("@mediapipe/hands");
    const instance = new (Hands as new (cfg: unknown) => unknown)({
      maxHands: 2,
    });
    expect(instance).toBeInstanceOf(FakeHands);
    expect(captured).toEqual([{ maxHands: 2 }]);
  });

  it("HAND_CONNECTIONS forwards length + index reads to window.HAND_CONNECTIONS", async () => {
    (window as unknown as Record<string, unknown>).HAND_CONNECTIONS = [
      [0, 1],
      [1, 2],
      [2, 3],
    ];
    const { HAND_CONNECTIONS } = await import("@mediapipe/hands");
    expect(HAND_CONNECTIONS.length).toBe(3);
    expect(HAND_CONNECTIONS[0]).toEqual([0, 1]);
    expect(HAND_CONNECTIONS[2]).toEqual([2, 3]);
  });

  it("HAND_CONNECTIONS returns an empty-shape view when the global isn't loaded yet", async () => {
    const { HAND_CONNECTIONS } = await import("@mediapipe/hands");
    expect(HAND_CONNECTIONS.length).toBe(0);
  });
});
