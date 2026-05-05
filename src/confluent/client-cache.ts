import { logger } from "@src/logger.js";

export interface ClientCacheOptions<V> {
  /** If set, entries idle longer than this are evicted and disposed. */
  idleTimeoutMs?: number;
  /** Called with the value when an entry is evicted, fails to fully build, or
   *  when the cache is shut down. Errors are caught and logged. */
  dispose?: (value: V) => Promise<void>;
}

/**
 * Single-flight, idle-evicting promise cache for heavy resources (Kafka
 * clients, REST clients, resolved endpoint URLs). Concurrent `get(key, build)`
 * calls for the same key share a single in-flight build. Successfully built
 * entries are kept until their idle timer fires (if configured) or
 * `shutdown()` is called; both paths invoke the optional `dispose` callback.
 *
 * Invariants:
 *   - At most one `build()` runs per key at a time (single-flight).
 *   - On `build()` rejection, the entry is evicted and the rejection
 *     re-thrown to the caller. The cache cannot dispose a value the build
 *     function never returned: if `build()` constructs heavy resources before
 *     throwing, the build function itself is responsible for cleaning them up
 *     (typically via a try/catch around the inner construction). Disposal
 *     here is reserved for successfully-built values that later evict.
 *   - `dispose` errors are swallowed (logged at warn) — failing to clean up
 *     one resource must not block the cache from cleaning up the rest.
 *   - `shutdown()` is idempotent.
 */
export class ClientCache<K, V> {
  private readonly entries = new Map<K, Promise<V>>();
  private readonly idleTimers = new Map<K, NodeJS.Timeout>();
  private readonly idleTimeoutMs?: number;
  private readonly dispose?: (value: V) => Promise<void>;

  constructor(opts: ClientCacheOptions<V> = {}) {
    this.idleTimeoutMs = opts.idleTimeoutMs;
    this.dispose = opts.dispose;
  }

  async get(key: K, build: () => Promise<V>): Promise<V> {
    let entry = this.entries.get(key);
    if (entry === undefined) {
      entry = build();
      this.entries.set(key, entry);
      try {
        await entry;
      } catch (err) {
        // Failed build: evict and re-throw. The cache cannot dispose a value
        // the build function never produced — if `build()` constructed heavy
        // resources before throwing, that cleanup is the build function's
        // responsibility (see invariants in the class docstring).
        this.entries.delete(key);
        throw err;
      }
    }
    this.resetIdleTimer(key);
    return entry;
  }

  async shutdown(): Promise<void> {
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();

    const disposes: Array<Promise<void>> = [];
    for (const entry of this.entries.values()) {
      disposes.push(this.disposeEntry(entry));
    }
    this.entries.clear();
    await Promise.allSettled(disposes);
  }

  private resetIdleTimer(key: K): void {
    if (this.idleTimeoutMs === undefined) return;
    const existing = this.idleTimers.get(key);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      const entry = this.entries.get(key);
      this.entries.delete(key);
      this.idleTimers.delete(key);
      if (entry !== undefined) void this.disposeEntry(entry);
    }, this.idleTimeoutMs);
    this.idleTimers.set(key, timer);
  }

  private async disposeEntry(entry: Promise<V>): Promise<void> {
    if (this.dispose === undefined) return;
    try {
      const value = await entry;
      await this.dispose(value);
    } catch (err) {
      // Includes both rejected build promises (no value to dispose) and
      // genuine dispose failures. Log and move on; the entry is already
      // gone from the cache.
      logger.warn(
        { err },
        "ClientCache dispose failed; resource may not be fully cleaned up",
      );
    }
  }
}
