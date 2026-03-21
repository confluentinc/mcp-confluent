import { defineConfig } from "vitest/config";

// LCOV for CI (sonarqube); text and HTML for local runs
const coverageReporters = process.env.CI ? ["lcov"] : ["text", "html"];

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
    coverage: {
      provider: "v8",
      reporter: coverageReporters,
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts"],
    },
  },
});
