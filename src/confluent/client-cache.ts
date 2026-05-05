import { logger } from "@src/logger.js";

export interface ClientCacheOptions<V> {
  idleTimeoutMs?: number;
  dispose?: (value: V) => Promise<void>;
}

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
      logger.warn({ err }, "ClientCache dispose failed; entry already removed");
    }
  }
}
