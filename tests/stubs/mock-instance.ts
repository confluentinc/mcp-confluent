import { type Mocked, vi } from "vitest";

/**
 * Creates a mocked instance of a class where every method on the prototype
 * chain (own + inherited, up to but excluding `Object.prototype`) is replaced
 * with a fresh {@linkcode vi.fn}. The returned object is typed as
 * {@link Mocked} of the class so method signatures (and thus IntelliSense
 * on `.mockResolvedValue` etc.) are preserved.
 *
 * Walking the chain matters for class hierarchies — e.g., `DirectClientManager`
 * extends `BaseClientManager`, and tests need to stub inherited REST-client
 * getters (`getConfluentCloudRestClient`, `getSchemaRegistryClient`, ...) the
 * same way they stub Kafka methods defined directly on the subclass.
 *
 * Use this for handler-style tests that want to stub a single dependency
 * class without spinning up the real thing. For cases that only need a
 * one-off function stub, prefer {@linkcode vi.fn} directly.
 *
 * @example
 * ```ts
 * const clientManager = createMockInstance(DirectClientManager);
 * clientManager.getAdminClient.mockResolvedValue(admin);
 * clientManager.getConfluentCloudRestClient.mockReturnValue(restClient);
 * ```
 */
// `(...args: never[])` is the canonical "accept any constructor" pattern in
// TypeScript: rest-parameter contravariance means a `never[]` parameter list
// is satisfied by every concrete constructor signature. `unknown[]` would be
// stricter and would reject classes whose constructor takes specific types
// (e.g., DirectClientManager's `ClientManagerConfig`).
export function createMockInstance<T extends object>(
  Ctor: new (...args: never[]) => T,
): Mocked<T> {
  const instance = Object.create(Ctor.prototype) as Mocked<T>;
  // Walk the prototype chain from Ctor.prototype up to (but excluding)
  // Object.prototype, stubbing every method we encounter. Iterating most-
  // derived to least-derived ensures overrides on the subclass shadow the
  // base method's stub (we skip keys already stubbed in a derived layer).
  let proto: object | null = Ctor.prototype;
  while (proto && proto !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key === "constructor") continue;
      if (Object.prototype.hasOwnProperty.call(instance, key)) continue;
      const desc = Object.getOwnPropertyDescriptor(proto, key);
      if (desc && typeof desc.value === "function") {
        (instance as Record<string, unknown>)[key] = vi.fn();
      }
    }
    proto = Object.getPrototypeOf(proto);
  }
  return instance;
}
