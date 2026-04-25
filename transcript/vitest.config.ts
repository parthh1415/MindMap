import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
    globals: false,
    // The tests don't depend on real timers from Vitest's modern fake API; we
    // use a hand-rolled mock clock + mock WebSocket. Keep config minimal.
    testTimeout: 10000,
  },
});
