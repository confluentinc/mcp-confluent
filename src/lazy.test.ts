import { AsyncLazy, Lazy } from "@src/lazy.js";
import { describe, expect, it, vi } from "vitest";

describe("Lazy", () => {
  it("should invoke the supplier exactly once across repeated get() calls", () => {
    const supplier = vi.fn(() => ({ id: 1 }));
    const lazy = new Lazy(supplier);

    const first = lazy.get();
    const second = lazy.get();

    expect(supplier).toHaveBeenCalledOnce();
    expect(second).toBe(first);
  });

  it("should rebuild via a fresh supplier invocation on get() after close()", () => {
    const supplier = vi.fn(() => ({ id: 1 }));
    const lazy = new Lazy(supplier);

    const first = lazy.get();
    lazy.close();
    const second = lazy.get();

    expect(supplier).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(first);
  });

  it("should wrap a throwing supplier as 'Failed to initialize lazy instance'", () => {
    const lazy = new Lazy(() => {
      throw new Error("boom");
    });

    expect(() => lazy.get()).toThrowError(
      "Failed to initialize lazy instance: Error: boom",
    );
  });

  it("should invoke the closeHandler with the cached instance, then clear it", () => {
    const instance = { id: 1 };
    const closeHandler = vi.fn();
    const supplier = vi.fn(() => instance);
    const lazy = new Lazy(supplier, closeHandler);

    lazy.get();
    lazy.close();

    expect(closeHandler).toHaveBeenCalledOnce();
    expect(closeHandler).toHaveBeenCalledWith(instance);
    expect(lazy["instance"]).toBeUndefined();
  });

  it("should be a no-op on close() when no instance was ever built", () => {
    const closeHandler = vi.fn();
    const lazy = new Lazy(() => ({ id: 1 }), closeHandler);

    lazy.close();

    expect(closeHandler).not.toHaveBeenCalled();
  });

  it("should clear the instance on close() even when no closeHandler was provided", () => {
    const supplier = vi.fn(() => ({ id: 1 }));
    const lazy = new Lazy(supplier);

    lazy.get();
    lazy.close();
    lazy.get();

    expect(supplier).toHaveBeenCalledTimes(2);
  });

  it("should cache a falsy value (0) rather than rebuild it", () => {
    const supplier = vi.fn(() => 0);
    const lazy = new Lazy(supplier);

    expect(lazy.get()).toBe(0);
    expect(lazy.get()).toBe(0);
    expect(supplier).toHaveBeenCalledOnce();
  });

  it("should clear a falsy cached value (0) on close() so the next get() rebuilds", () => {
    const closeHandler = vi.fn();
    const supplier = vi.fn(() => 0);
    const lazy = new Lazy(supplier, closeHandler);

    lazy.get();
    lazy.close();
    lazy.get();

    expect(closeHandler).toHaveBeenCalledOnce();
    expect(closeHandler).toHaveBeenCalledWith(0);
    expect(supplier).toHaveBeenCalledTimes(2);
  });
});

describe("AsyncLazy", () => {
  it("should invoke the supplier exactly once across repeated awaited get() calls", async () => {
    const supplier = vi.fn(async () => ({ id: 1 }));
    const lazy = new AsyncLazy(supplier);

    const first = await lazy.get();
    const second = await lazy.get();

    expect(supplier).toHaveBeenCalledOnce();
    expect(second).toBe(first);
  });

  it("should dedupe concurrent get() calls to a single supplier invocation", async () => {
    let resolveSupplier: (value: { id: number }) => void;
    const supplier = vi.fn(
      () =>
        new Promise<{ id: number }>((resolve) => {
          resolveSupplier = resolve;
        }),
    );
    const lazy = new AsyncLazy(supplier);

    const firstPromise = lazy.get();
    const secondPromise = lazy.get();
    resolveSupplier!({ id: 1 });

    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(supplier).toHaveBeenCalledOnce();
    expect(second).toBe(first);
  });

  it("should rebuild via a fresh supplier invocation on get() after close()", async () => {
    const supplier = vi.fn(async () => ({ id: 1 }));
    const lazy = new AsyncLazy(supplier);

    const first = await lazy.get();
    await lazy.close();
    const second = await lazy.get();

    expect(supplier).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(first);
  });

  it("should retry the supplier on the next get() after a rejected initialization", async () => {
    const supplier = vi
      .fn<() => Promise<{ id: number }>>()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue({ id: 1 });
    const lazy = new AsyncLazy(supplier);

    await expect(lazy.get()).rejects.toThrowError("transient");

    const recovered = await lazy.get();

    expect(supplier).toHaveBeenCalledTimes(2);
    expect(recovered).toEqual({ id: 1 });
  });

  it("should invoke the async closeHandler, then reset instance and initializationPromise", async () => {
    const instance = { id: 1 };
    const closeHandler = vi.fn(async () => {});
    const lazy = new AsyncLazy(async () => instance, closeHandler);

    await lazy.get();
    await lazy.close();

    expect(closeHandler).toHaveBeenCalledOnce();
    expect(closeHandler).toHaveBeenCalledWith(instance);
    expect(lazy["instance"]).toBeUndefined();
    expect(lazy["initializationPromise"]).toBeNull();
  });

  it("should be a no-op on close() when no instance was ever built", async () => {
    const closeHandler = vi.fn(async () => {});
    const lazy = new AsyncLazy(async () => ({ id: 1 }), closeHandler);

    await lazy.close();

    expect(closeHandler).not.toHaveBeenCalled();
  });

  it("should cache a falsy value (0) rather than rebuild it", async () => {
    const supplier = vi.fn(async () => 0);
    const lazy = new AsyncLazy(supplier);

    expect(await lazy.get()).toBe(0);
    expect(await lazy.get()).toBe(0);
    expect(supplier).toHaveBeenCalledOnce();
  });

  it("should clear a falsy cached value (0) on close() so the next get() rebuilds", async () => {
    const closeHandler = vi.fn(async () => {});
    const supplier = vi.fn(async () => 0);
    const lazy = new AsyncLazy(supplier, closeHandler);

    await lazy.get();
    await lazy.close();
    await lazy.get();

    expect(closeHandler).toHaveBeenCalledOnce();
    expect(closeHandler).toHaveBeenCalledWith(0);
    expect(supplier).toHaveBeenCalledTimes(2);
  });
});
