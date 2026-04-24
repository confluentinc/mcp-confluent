import { type Mocked, vi } from "vitest";

/**
 * Creates a mocked instance of a class where every prototype method is
 * replaced with a fresh {@linkcode vi.fn}. The returned object is typed as
 * {@link Mocked} of the class so method signatures (and thus IntelliSense
 * on `.mockResolvedValue` etc.) are preserved.
 *
 * Use this for handler-style tests that want to stub a single dependency
 * class without spinning up the real thing. For cases that only need a
 * one-off function stub, prefer {@linkcode vi.fn} directly.
 *
 * @example
 * ```ts
 * const clientManager = createMockInstance(DefaultClientManager);
 * clientManager.getAdminClient.mockResolvedValue(admin);
 * ```
 */
// `(...args: never[])` is the canonical "accept any constructor" pattern in
// TypeScript: rest-parameter contravariance means a `never[]` parameter list
// is satisfied by every concrete constructor signature. `unknown[]` would be
// stricter and would reject classes whose constructor takes specific types
// (e.g., DefaultClientManager's `ClientManagerConfig`).
export function createMockInstance<T extends object>(
  Ctor: new (...args: never[]) => T,
): Mocked<T> {
  const instance = Object.create(Ctor.prototype) as Mocked<T>;
  for (const key of Object.getOwnPropertyNames(Ctor.prototype)) {
    if (key === "constructor") continue;
    const desc = Object.getOwnPropertyDescriptor(Ctor.prototype, key);
    if (desc && typeof desc.value === "function") {
      (instance as Record<string, unknown>)[key] = vi.fn();
    }
  }
  return instance;
}
