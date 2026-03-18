import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    include: ["src/**/*.test.ts"],
    globals: false,
    restoreMocks: true,
    testTimeout: 10_000,
    reporters: ["verbose", "junit"],
    outputFile: {
      junit: "TEST-result.xml",
    },
  },
});
