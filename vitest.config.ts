import { defineConfig } from "vitest/config";
import { Tag } from "./tests/tags.js";

// LCOV for CI (sonarqube); text, HTML, and json-summary for local runs
const coverageReporters = process.env.CI
  ? ["lcov"]
  : ["text", "html", "json-summary"];

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    globals: false,
    restoreMocks: true,
    // Silences the app logger's info/warn chatter (tool enable/disable, client
    // init messages, etc.) during tests — both unit and integration inherit
    // via extends: true. Error-level keeps real failures visible: Zod env
    // validation, token-refresh errors, and anything else in the `logger.error`
    // paths still surfaces through stdio's inherited stderr and HTTP's buffer.
    // Propagates to the integration harness's spawned server via buildEnv()
    // in start-server.ts, which copies process.env.
    env: { LOG_LEVEL: "error" },
    reporters: ["verbose", "junit"],
    // JUnit output file name is shared across projects — CI jobs run a single project at a time so
    // there's no collision (`--project unit` or `--project integration`)
    outputFile: { junit: "TEST-result.xml" },
    coverage: {
      provider: "v8",
      reporter: coverageReporters,
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts"],
    },
    // Pre-declare every handler-subdirectory tag so follow-up PRs can add integration
    // tests without touching this config. Values come from `tests/tags.ts` (the single
    // source of truth shared with the test files).
    tags: Object.values(Tag).map((name) => ({ name })),
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.integration.test.ts"],
          testTimeout: 10_000,
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["src/**/*.integration.test.ts"],
          // increased timeout due to making real HTTP requests to CCloud
          testTimeout: 60_000,
          // server spawn + tool registration + /ping handshake can take more than the 10s default
          hookTimeout: 60_000,
          // one fork per test file so each test spawns its own MCP server process and binds its own
          // HTTP port without collisions
          pool: "forks",
          // Silence Node's DEP0040 (punycode) deprecation warning from transitive deps in
          // the worker process. --no-deprecation also silences any other deprecation warnings
          // during the test run, which is acceptable scope for integration runs — `npm run dev`
          // still surfaces them for authoring work. (vitest v4 moved this out of
          // poolOptions.forks.execArgv to a top-level project `execArgv`.)
          execArgv: ["--no-deprecation"],
          // asserts base CCloud env vars before any test runs
          setupFiles: ["tests/harness/setup.ts"],
        },
      },
    ],
  },
});
