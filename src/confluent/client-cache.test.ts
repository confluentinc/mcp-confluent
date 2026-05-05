import { ClientCache } from "@src/confluent/client-cache.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("ClientCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls build() on cold get and caches the value", async () => {
    const cache = new ClientCache<string, string>();
    const build = vi.fn().mockResolvedValue("v");
    expect(await cache.get("k", build)).toBe("v");
    expect(build).toHaveBeenCalledTimes(1);
    expect(await cache.get("k", build)).toBe("v");
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("single-flights concurrent gets for the same key", async () => {
    const cache = new ClientCache<string, string>();
    let resolveBuild!: (v: string) => void;
    const build = vi.fn(
      () =>
        new Promise<string>((r) => {
          resolveBuild = r;
        }),
    );
    const p1 = cache.get("k", build);
    const p2 = cache.get("k", build);
    resolveBuild("v");
    await expect(p1).resolves.toBe("v");
    await expect(p2).resolves.toBe("v");
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("evicts and disposes after idle timeout", async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const cache = new ClientCache<string, string>({
      idleTimeoutMs: 1000,
      dispose,
    });
    const build = vi.fn().mockResolvedValue("v");
    await cache.get("k", build);
    await vi.advanceTimersByTimeAsync(1500);
    expect(dispose).toHaveBeenCalledWith("v");
    await cache.get("k", build);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it("resets the idle timer on each get", async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const cache = new ClientCache<string, string>({
      idleTimeoutMs: 1000,
      dispose,
    });
    const build = vi.fn().mockResolvedValue("v");
    await cache.get("k", build);
    await vi.advanceTimersByTimeAsync(800);
    await cache.get("k", build);
    await vi.advanceTimersByTimeAsync(800);
    expect(dispose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(400);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("evicts the key when build() rejects so a retry rebuilds", async () => {
    const cache = new ClientCache<string, string>();
    const err = new Error("boom");
    const build1 = vi.fn().mockRejectedValueOnce(err);
    await expect(cache.get("k", build1)).rejects.toThrow("boom");
    const build2 = vi.fn().mockResolvedValue("v");
    expect(await cache.get("k", build2)).toBe("v");
    expect(build2).toHaveBeenCalledTimes(1);
  });

  it("swallows dispose() failures and still removes the key", async () => {
    const dispose = vi.fn().mockRejectedValue(new Error("disconnect failed"));
    const cache = new ClientCache<string, string>({
      idleTimeoutMs: 1000,
      dispose,
    });
    const build = vi.fn().mockResolvedValue("v");
    await cache.get("k", build);
    await vi.advanceTimersByTimeAsync(1500);
    await cache.get("k", build);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it("shutdown disposes every present entry and is idempotent", async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const cache = new ClientCache<string, string>({ dispose });
    await cache.get("a", () => Promise.resolve("va"));
    await cache.get("b", () => Promise.resolve("vb"));
    await cache.shutdown();
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledWith("va");
    expect(dispose).toHaveBeenCalledWith("vb");
    await cache.shutdown();
    expect(dispose).toHaveBeenCalledTimes(2);
  });
});
