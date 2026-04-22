import * as nodeDeps from "@src/confluent/node-deps.js";
import { type Mock, vi } from "vitest";

/**
 * Mocked {@link nodeDeps.fs} wrapper methods. Spies are auto-restored by
 * the `restoreMocks: true` setting in `vitest.config.ts`.
 */
export type MockedFsWrappers = {
  existsSync: Mock;
  readFileSync: Mock;
  writeFileSync: Mock;
  mkdirSync: Mock;
};

/**
 * Replaces all fs wrapper methods in {@linkcode nodeDeps.fs} with
 * {@linkcode vi.fn} spies. Tests can tune each spy's behavior with
 * `mockReturnValue`, `mockImplementation`, etc.
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
  } as MockedFsWrappers;
}

/** Mocked {@linkcode nodeDeps.nodeFetch} wrapper. */
export type MockedFetchWrapper = {
  fetch: Mock;
};

/**
 * Replaces the fetch wrapper in {@linkcode nodeDeps.nodeFetch} with a
 * {@linkcode vi.fn} spy.
 */
export function createFetchWrapper(): MockedFetchWrapper {
  return {
    fetch: vi.spyOn(nodeDeps.nodeFetch, "fetch"),
  } as MockedFetchWrapper;
}

/** Mocked {@linkcode nodeDeps.nodeCrypto} wrapper. */
export type MockedCryptoWrapper = {
  randomBytes: Mock;
};

/**
 * Replaces the crypto wrapper in {@linkcode nodeDeps.nodeCrypto} with a
 * {@linkcode vi.fn} spy.
 */
export function createCryptoWrapper(): MockedCryptoWrapper {
  return {
    randomBytes: vi.spyOn(nodeDeps.nodeCrypto, "randomBytes"),
  } as MockedCryptoWrapper;
}
