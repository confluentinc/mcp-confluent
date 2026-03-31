import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    include: ["tests/integration/**/*.integration.test.ts"],
    globals: false,
    testTimeout: 60_000,
    hookTimeout: 30_000,
    reporters: ["verbose"],
    sequence: {
      // Run test files sequentially to avoid resource conflicts
      concurrent: false,
    },
  },
});
