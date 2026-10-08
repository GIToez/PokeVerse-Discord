import { defineConfig } from "vitest/config";

// Runs against a real PokeVerse game server (see docs/TESTING.md).
export default defineConfig({
  test: {
    include: ["tests/live/**/*.test.ts"],
    environment: "node",
    testTimeout: 120000,
    hookTimeout: 120000,
    fileParallelism: false,
  },
});
