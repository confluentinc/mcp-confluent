import * as nodeDeps from "@src/confluent/node-deps.js";
import { type MockInstance, vi } from "vitest";

/**
 * Spies installed on every fs wrapper method in {@linkcode nodeDeps.fs}.
 * Auto-restored between tests by the `restoreMocks: true` setting in
 * `vitest.config.ts`.
 *
 * Note: each entry is a {@linkcode vi.spyOn} result that **calls through to
 * the real implementation by default**. Tests must call `.mockReturnValue`
 * (or similar) to override behavior; otherwise the wrapped fs primitive
 * runs against the real filesystem.
 */
export type MockedFsWrappers = {
  existsSync: MockInstance<typeof nodeDeps.fs.existsSync>;
  readFileSync: MockInstance<typeof nodeDeps.fs.readFileSync>;
  writeFileSync: MockInstance<typeof nodeDeps.fs.writeFileSync>;
  mkdirSync: MockInstance<typeof nodeDeps.fs.mkdirSync>;
};

/**
 * Installs {@linkcode vi.spyOn} on each fs wrapper method.
 *
 * The returned spies are call-through by default; configure each spy with
 * `mockReturnValue` / `mockImplementation` in the test to control behavior.
 *
 * @example
 * ```ts
 * const fsMocks = createFsWrappers();
 * fsMocks.existsSync.mockReturnValue(true);
 * fsMocks.readFileSync.mockReturnValue("file contents");
 * ```
 */
export function createFsWrappers(): MockedFsWrappers {
  return {
    existsSync: vi.spyOn(nodeDeps.fs, "existsSync"),
    readFileSync: vi.spyOn(nodeDeps.fs, "readFileSync"),
    writeFileSync: vi.spyOn(nodeDeps.fs, "writeFileSync"),
    mkdirSync: vi.spyOn(nodeDeps.fs, "mkdirSync"),
  };
}

/**
 * Spy on the env-proxy getter ({@linkcode nodeDeps.config.env}) and return
 * the supplied partial as the full env object. Lets tests express only the
 * env vars they actually care about without listing every other field.
 *
 * @example
 * ```ts
 * mockEnv({ DO_NOT_TRACK: true });
 * ```
 */
export function mockEnv(overrides: Partial<typeof nodeDeps.config.env>): void {
  vi.spyOn(nodeDeps.config, "env", "get").mockReturnValue(
    overrides as unknown as typeof nodeDeps.config.env,
  );
}
