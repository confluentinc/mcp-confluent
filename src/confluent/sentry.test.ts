import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `sentry.ts` keeps module-level init state, so each test re-imports it (and
// its node-deps dependency) fresh via resetModules to avoid cross-test leakage.
type NodeDeps = typeof import("@src/confluent/node-deps.js");
type SentryModule = typeof import("@src/confluent/sentry.js");

describe("Sentry integration", () => {
  let nodeDeps: NodeDeps;
  let mod: SentryModule;
  let initStub: ReturnType<typeof vi.spyOn>;
  let captureStub: ReturnType<typeof vi.spyOn>;
  let closeStub: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.resetModules();
    nodeDeps = await import("@src/confluent/node-deps.js");
    initStub = vi
      .spyOn(nodeDeps.sentry, "init")
      .mockImplementation(() => undefined);
    captureStub = vi
      .spyOn(nodeDeps.sentry, "captureException")
      .mockImplementation(() => "id");
    closeStub = vi.spyOn(nodeDeps.sentry, "close").mockResolvedValue(true);
    mod = await import("@src/confluent/sentry.js");
  });

  afterEach(() => vi.restoreAllMocks());

  const opts = {
    dsn: "https://abc@o0.ingest.sentry.io/1",
    release: "1.0.0",
    transports: ["stdio"] as const,
  };

  it("does not init when doNotTrack is true (zero outbound events)", () => {
    mod.initSentry({ ...opts, doNotTrack: true });
    expect(initStub).not.toHaveBeenCalled();
    mod.captureException(new Error("boom"));
    expect(captureStub).not.toHaveBeenCalled();
  });

  it("does not init when the DSN is empty", () => {
    mod.initSentry({ ...opts, dsn: "", doNotTrack: false });
    expect(initStub).not.toHaveBeenCalled();
    mod.captureException(new Error("boom"));
    expect(captureStub).not.toHaveBeenCalled();
  });

  it("inits and captures when consented with a DSN", () => {
    mod.initSentry({ ...opts, doNotTrack: false });
    expect(initStub).toHaveBeenCalledTimes(1);
    const cfg = initStub.mock.calls[0][0];
    expect(cfg).toMatchObject({
      dsn: opts.dsn,
      release: "1.0.0",
      includeLocalVariables: false,
      tracesSampleRate: 0,
      debug: false,
      dataCollection: { userInfo: false, httpBodies: [] },
    });
    expect(typeof cfg.beforeSend).toBe("function");

    mod.captureException(new Error("boom"), {
      tags: { toolName: "list-topics" },
    });
    expect(captureStub).toHaveBeenCalledWith(expect.any(Error), {
      tags: { toolName: "list-topics" },
    });
  });

  it("closeSentry flushes only when initialized", async () => {
    await mod.closeSentry(1000);
    expect(closeStub).not.toHaveBeenCalled();
    mod.initSentry({ ...opts, doNotTrack: false });
    await mod.closeSentry(1000);
    expect(closeStub).toHaveBeenCalledWith(1000);
  });
});
