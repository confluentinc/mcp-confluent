import { bootstrap } from "@src/index.js";
import { MINIMUM_NODE_VERSION } from "@src/preflight.js";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("bootstrap", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should load the server entry on a supported runtime without exiting", async () => {
    const exit = vi.fn();
    const loadAndRunServer = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValue(undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await bootstrap({
      currentVersion: MINIMUM_NODE_VERSION,
      exit,
      loadAndRunServer,
    });

    expect(loadAndRunServer).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("should print the version error and exit(1) without loading the server on an old runtime", async () => {
    const exit = vi.fn();
    const loadAndRunServer = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValue(undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await bootstrap({ currentVersion: "18.20.4", exit, loadAndRunServer });

    expect(loadAndRunServer).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy.mock.calls[0]?.[0]).toContain(
      `Node.js ${MINIMUM_NODE_VERSION} or newer`,
    );
    expect(errorSpy.mock.calls[0]?.[0]).toContain("18.20.4");
  });
});
