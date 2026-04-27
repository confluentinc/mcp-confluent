import * as nodeDeps from "@src/confluent/node-deps.js";
import { type MockInstance, vi } from "vitest";

/**
 * Spies installed on every fs wrapper method in {@linkcode nodeDeps.fs}.
 * Auto-restored between tests by the `restoreMocks: true` setting in
 * `vitest.config.ts`.
 *
 * Read methods (`existsSync`, `readFileSync`) call through to the real fs
 * by default; tests should override with `.mockReturnValue(...)`. Write
 * methods (`writeFileSync`, `mkdirSync`) are no-op-by-default to prevent
 * an unmocked call from accidentally mutating the real filesystem.
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
 * Read spies (`existsSync`, `readFileSync`) call through by default; real
 * `existsSync` on a non-existent path returns `false` and real `readFileSync`
 * throws ENOENT, both of which surface a missed mock loudly. Write spies
 * (`writeFileSync`, `mkdirSync`) are no-op-by-default so an unmocked call
 * doesn't accidentally mutate the real filesystem.
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
    writeFileSync: vi
      .spyOn(nodeDeps.fs, "writeFileSync")
      .mockImplementation(() => undefined),
    mkdirSync: vi
      .spyOn(nodeDeps.fs, "mkdirSync")
      .mockImplementation(
        () => undefined as ReturnType<typeof nodeDeps.fs.mkdirSync>,
      ),
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

/**
 * Spy returned by {@linkcode mockFetch}. Auto-restored between tests by the
 * `restoreMocks: true` setting in `vitest.config.ts`.
 */
export type MockedFetch = MockInstance<typeof nodeDeps.nodeFetch.fetch>;

/**
 * Install a {@linkcode vi.spyOn} on {@linkcode nodeDeps.nodeFetch.fetch} that
 * throws "Unexpected fetch" by default. Tests must opt-in to each expected
 * request via `.mockResolvedValueOnce(...)` (preferred for chains) or
 * `.mockResolvedValue(...)` (steady-state) so that missed mocks fail loudly
 * instead of hitting the real network.
 *
 * @example
 * ```ts
 * const fetchSpy = mockFetch();
 * fetchSpy.mockResolvedValueOnce(new Response('{"ok":true}'));
 * ```
 */
export function mockFetch(): MockedFetch {
  return vi.spyOn(nodeDeps.nodeFetch, "fetch").mockImplementation(async () => {
    throw new Error(
      "mockFetch(): unstubbed fetch call. " +
        "Add .mockResolvedValueOnce(response) per expected request, " +
        "or .mockResolvedValue(response) for a steady-state default.",
    );
  });
}

/**
 * Spy returned by {@linkcode mockDotenv}.
 */
export type MockedDotenv = MockInstance<typeof nodeDeps.dotenvLib.config>;

/**
 * Install a {@linkcode vi.spyOn} on {@linkcode nodeDeps.dotenvLib.config}
 * that throws "Unexpected dotenv.config" by default. Calling the real
 * `dotenv.config` mutates `process.env` (a shared singleton) using the
 * developer's cwd-local `.env` file, which can leak non-deterministic state
 * into other tests; this helper makes any unmocked invocation fail loudly.
 *
 * @example
 * ```ts
 * const dotenvSpy = mockDotenv();
 * dotenvSpy.mockReturnValue({ parsed: { FOO: "bar" } });
 * ```
 */
export function mockDotenv(): MockedDotenv {
  return vi.spyOn(nodeDeps.dotenvLib, "config").mockImplementation(() => {
    throw new Error(
      "mockDotenv(): unstubbed dotenv.config() call. " +
        "Add .mockReturnValue({ parsed: { ... } }) for a successful load, " +
        "or .mockReturnValue({ error: new Error(...) }) for a failure.",
    );
  });
}
