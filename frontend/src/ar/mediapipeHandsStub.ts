// Vite alias target for the bare specifier "@mediapipe/hands".
//
// Why this exists:
//   The real @mediapipe/hands package is an IIFE script with zero ES
//   exports — it registers `Hands`, `HAND_CONNECTIONS`, `VERSION` on
//   `window` via Closure Library's goog.exportSymbol. Strict ESM linkers
//   (Safari especially) crash at module load when hand-pose-detection's
//   ESM build does `import { Hands } from "@mediapipe/hands"`.
//
// Strategy: alias the bare specifier to this stub. The stub's exports
// are LAZY proxies that forward to `window.Hands` at the moment of
// access — by which time we've injected /mediapipe/hands/hands.js as a
// `<script>` tag (handled by initDetector before createDetector runs).
//
// With this in place, runtime: "mediapipe" + local solutionPath works
// exactly per the friend's spec — fast model load, accurate two-hand
// tracking, no TFHub network fetch.

declare global {
  interface Window {
    Hands?: new (config: unknown) => unknown;
    HAND_CONNECTIONS?: ReadonlyArray<readonly [number, number]>;
    VERSION?: string;
  }
}

function readGlobal<T>(key: "Hands" | "HAND_CONNECTIONS" | "VERSION"): T {
  const w = (typeof window !== "undefined"
    ? (window as unknown as Record<string, unknown>)
    : {});
  const v = w[key];
  if (v == null) {
    throw new Error(
      `@mediapipe/hands global '${key}' not loaded — initDetector must inject /mediapipe/hands/hands.js before constructing the detector`,
    );
  }
  return v as T;
}

// Lazily-resolving constructor. `new Hands(config)` triggers the
// `construct` trap which calls `new window.Hands(config)`. `Hands(...)`
// (without `new`) is supported via the `apply` trap for completeness.
export const Hands = new Proxy(function () {} as unknown as new (
  config: unknown,
) => unknown, {
  construct(_target, args) {
    const Real = readGlobal<new (...a: unknown[]) => object>("Hands");
    return Reflect.construct(Real, args);
  },
  apply(_target, _thisArg, args) {
    const Real = readGlobal<(...a: unknown[]) => unknown>("Hands");
    return Real.apply(undefined, args);
  },
});

// HAND_CONNECTIONS is a readonly array — forward index/length reads.
export const HAND_CONNECTIONS = new Proxy(
  [] as ReadonlyArray<readonly [number, number]>,
  {
    get(_target, prop, receiver) {
      const real =
        (typeof window !== "undefined" && window.HAND_CONNECTIONS) || [];
      return Reflect.get(real, prop, receiver);
    },
    has(_target, prop) {
      const real =
        (typeof window !== "undefined" && window.HAND_CONNECTIONS) || [];
      return Reflect.has(real, prop);
    },
    ownKeys() {
      const real =
        (typeof window !== "undefined" && window.HAND_CONNECTIONS) || [];
      return Reflect.ownKeys(real);
    },
    getOwnPropertyDescriptor(_target, prop) {
      const real =
        (typeof window !== "undefined" && window.HAND_CONNECTIONS) || [];
      return Reflect.getOwnPropertyDescriptor(real, prop);
    },
  },
);

// VERSION is just a string — return whatever the loaded IIFE set, or
// a sentinel before the script lands.
export const VERSION =
  typeof window !== "undefined" && window.VERSION ? window.VERSION : "stub";
