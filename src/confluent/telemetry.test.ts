import * as nodeDeps from "@src/confluent/node-deps.js";
import {
  FALLBACK_MACHINE_ID,
  TelemetryEvent,
  TelemetryService,
} from "@src/confluent/telemetry.js";
import {
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  type MockInstance,
  vi,
} from "vitest";

describe("TelemetryService", () => {
  let trackStub: Mock;
  let identifyStub: Mock;
  let closeAndFlushStub: Mock;
  let analyticsConstructorStub: MockInstance<
    (typeof nodeDeps.segment)["Analytics"]
  >;
  let readFileSyncStub: MockInstance<typeof nodeDeps.fs.readFileSync>;
  let writeFileSyncStub: MockInstance<typeof nodeDeps.fs.writeFileSync>;
  let mkdirSyncStub: MockInstance<typeof nodeDeps.fs.mkdirSync>;

  beforeEach(() => {
    // analytics stubs (via wrapper for ESM compatibility)
    trackStub = vi.fn();
    identifyStub = vi.fn();
    closeAndFlushStub = vi.fn().mockResolvedValue(undefined);
    // `new segment.Analytics(...)` requires a constructable function —
    // arrow functions can't be called with `new`.
    analyticsConstructorStub = vi.spyOn(nodeDeps.segment, "Analytics");
    analyticsConstructorStub.mockImplementation(function MockAnalytics(
      this: unknown,
    ) {
      // Real Analytics has many methods; the service only calls these three,
      // so we return a partial and cast through `unknown` rather than stub
      // the rest of the surface.
      return {
        track: trackStub,
        identify: identifyStub,
        closeAndFlush: closeAndFlushStub,
      } as unknown as InstanceType<typeof nodeDeps.segment.Analytics>;
    });

    // node builtin stubs (via wrapper for ESM compatibility)
    readFileSyncStub = vi
      .spyOn(nodeDeps.fs, "readFileSync")
      .mockImplementation(() => {
        throw new Error("ENOENT");
      });
    // safe defaults: no-op so the test never writes real files under
    // /tmp/test-home when TelemetryService persists the machine ID. Per-test
    // overrides (e.g. mkdirSync throwing EACCES) replace these.
    writeFileSyncStub = vi
      .spyOn(nodeDeps.fs, "writeFileSync")
      .mockImplementation(() => undefined);
    mkdirSyncStub = vi
      .spyOn(nodeDeps.fs, "mkdirSync")
      .mockImplementation(
        () => undefined as ReturnType<typeof nodeDeps.fs.mkdirSync>,
      );
    vi.spyOn(nodeDeps.os, "homedir").mockReturnValue("/tmp/test-home");

    TelemetryService["instance"] = undefined;
  });

  describe("initialize / getInstance contract", () => {
    it("should throw when getInstance is called before initialize", () => {
      expect(() => TelemetryService.getInstance()).toThrow(
        /initialize\(\) must be called before getInstance\(\)/,
      );
    });

    it("should throw when initialize is called a second time", () => {
      TelemetryService.initialize({ doNotTrack: false, writeKey: undefined });
      expect(() =>
        TelemetryService.initialize({ doNotTrack: false, writeKey: undefined }),
      ).toThrow(/already been initialized/);
    });

    it("should return the same instance across multiple getInstance calls", () => {
      TelemetryService.initialize({ doNotTrack: false, writeKey: undefined });
      const a = TelemetryService.getInstance();
      const b = TelemetryService.getInstance();
      expect(a).toBe(b);
    });
  });

  describe("activation", () => {
    it("should be enabled when initialize receives a writeKey", () => {
      TelemetryService.initialize({
        doNotTrack: false,
        writeKey: "real-key",
      });

      const service = TelemetryService.getInstance();
      service.track(TelemetryEvent.TOOL_CALL, {
        toolName: "list_topics",
      });

      expect(trackStub).toHaveBeenCalledOnce();
      expect(analyticsConstructorStub).toHaveBeenCalledWith(
        expect.objectContaining({ writeKey: "real-key" }),
      );
    });

    it("should be disabled when initialize receives writeKey: undefined", () => {
      TelemetryService.initialize({ doNotTrack: false, writeKey: undefined });

      const service = TelemetryService.getInstance();
      service.track(TelemetryEvent.TOOL_CALL, {
        toolName: "list_topics",
      });

      expect(trackStub).not.toHaveBeenCalled();
      expect(analyticsConstructorStub).not.toHaveBeenCalled();
    });

    it("should be disabled when initialize receives an empty-string writeKey", () => {
      TelemetryService.initialize({ doNotTrack: false, writeKey: "" });

      const service = TelemetryService.getInstance();
      service.track(TelemetryEvent.TOOL_CALL, {
        toolName: "list_topics",
      });

      expect(trackStub).not.toHaveBeenCalled();
      expect(analyticsConstructorStub).not.toHaveBeenCalled();
    });

    it("should be disabled when initialized with doNotTrack: true, even with a valid writeKey", () => {
      TelemetryService.initialize({ doNotTrack: true, writeKey: "real-key" });

      const service = TelemetryService.getInstance();
      service.track(TelemetryEvent.TOOL_CALL, {
        toolName: "list_topics",
      });

      expect(trackStub).not.toHaveBeenCalled();
    });
  });

  describe("tracking", () => {
    let service: TelemetryService;

    beforeEach(() => {
      TelemetryService.initialize({ doNotTrack: false, writeKey: "real-key" });
      service = TelemetryService.getInstance();
    });

    it("should include event properties and machine ID as userId", () => {
      service.track(TelemetryEvent.TOOL_CALL, {
        toolName: "describe_topic",
        durationMs: 100,
      });

      expect(trackStub).toHaveBeenCalledOnce();
      expect(trackStub).toHaveBeenCalledWith(
        expect.objectContaining({
          event: TelemetryEvent.TOOL_CALL,
          userId: expect.any(String),
          properties: expect.objectContaining({
            toolName: "describe_topic",
            durationMs: 100,
            serverSessionId: expect.any(String),
            osPlatform: expect.any(String),
            osVersion: expect.any(String),
            osArch: expect.any(String),
          }),
        }),
      );
    });

    it("should forward identify calls to the analytics client", () => {
      service.identify("user-123", { org: "acme" });

      expect(identifyStub).toHaveBeenCalledOnce();
      expect(identifyStub).toHaveBeenCalledWith({
        userId: "user-123",
        traits: { org: "acme" },
      });
    });

    it("should skip identify calls when initialized with doNotTrack: true", () => {
      TelemetryService["instance"] = undefined;
      TelemetryService.initialize({ doNotTrack: true, writeKey: "real-key" });

      const disabled = TelemetryService.getInstance();
      disabled.identify("user-123", { org: "acme" });

      expect(identifyStub).not.toHaveBeenCalled();
    });
  });

  describe("machine ID persistence", () => {
    it("should generate and write a new UUID when no machine-id file exists", () => {
      TelemetryService.initialize({ doNotTrack: false, writeKey: "real-key" });

      TelemetryService.getInstance();

      expect(writeFileSyncStub).toHaveBeenCalledOnce();
      expect(writeFileSyncStub).toHaveBeenCalledWith(
        expect.stringContaining("machine-id"),
        expect.any(String),
        expect.anything(),
      );
    });

    it("should reuse an existing UUID when a machine-id file exists", () => {
      readFileSyncStub.mockReturnValue("existing-uuid");
      TelemetryService.initialize({ doNotTrack: false, writeKey: "real-key" });

      const service = TelemetryService.getInstance();
      service.track(TelemetryEvent.TOOL_CALL, {});

      expect(trackStub).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "existing-uuid" }),
      );
    });

    it("should fall back to an anonymous ID when the file system is not writable", () => {
      mkdirSyncStub.mockImplementation(() => {
        throw new Error("EACCES");
      });
      TelemetryService.initialize({ doNotTrack: false, writeKey: "real-key" });

      const service = TelemetryService.getInstance();
      service.track(TelemetryEvent.TOOL_CALL, {});

      expect(trackStub).toHaveBeenCalledWith(
        expect.objectContaining({ userId: FALLBACK_MACHINE_ID }),
      );
    });
  });

  describe("shutdown", () => {
    it("should flush the analytics client on shutdown", async () => {
      TelemetryService.initialize({ doNotTrack: false, writeKey: "real-key" });

      await TelemetryService.getInstance().shutdown();

      expect(closeAndFlushStub).toHaveBeenCalledOnce();
      expect(closeAndFlushStub).toHaveBeenCalledWith({ timeout: 5000 });
    });

    it("should be a no-op when telemetry is disabled", async () => {
      TelemetryService.initialize({ doNotTrack: false, writeKey: undefined });

      await TelemetryService.getInstance().shutdown();

      expect(closeAndFlushStub).not.toHaveBeenCalled();
    });
  });

  describe("common properties", () => {
    let service: TelemetryService;

    beforeEach(() => {
      TelemetryService.initialize({ doNotTrack: false, writeKey: "real-key" });
      service = TelemetryService.getInstance();
    });

    it("should include OS info in every event", () => {
      service.track(TelemetryEvent.TOOL_CALL, { toolName: "test" });

      expect(trackStub).toHaveBeenCalledWith(
        expect.objectContaining({
          properties: expect.objectContaining({
            osPlatform: expect.any(String),
            osVersion: expect.any(String),
            osArch: expect.any(String),
          }),
        }),
      );
    });

    it("should merge properties set via setCommonProperties into every event", () => {
      service.setCommonProperties({
        serverVersion: "1.2.0",
        clientName: "claude-code",
        clientVersion: "2.1.87",
      });

      service.track(TelemetryEvent.TOOL_CALL, { toolName: "test" });

      expect(trackStub).toHaveBeenCalledWith(
        expect.objectContaining({
          properties: expect.objectContaining({
            serverVersion: "1.2.0",
            clientName: "claude-code",
            clientVersion: "2.1.87",
            osPlatform: expect.any(String),
            serverSessionId: expect.any(String),
          }),
        }),
      );
    });

    it("should allow per-event properties to override common properties", () => {
      service.setCommonProperties({ serverVersion: "1.0.0" });

      service.track(TelemetryEvent.TOOL_CALL, {
        serverVersion: "override",
      });

      expect(trackStub).toHaveBeenCalledWith(
        expect.objectContaining({
          properties: expect.objectContaining({ serverVersion: "override" }),
        }),
      );
    });
  });

  describe("tool call status", () => {
    let service: TelemetryService;

    beforeEach(() => {
      TelemetryService.initialize({ doNotTrack: false, writeKey: "real-key" });
      service = TelemetryService.getInstance();
    });

    it("should include a success status for successful tool calls", () => {
      service.track(TelemetryEvent.TOOL_CALL, {
        toolName: "list_topics",
        durationMs: 100,
        status: "success",
      });

      expect(trackStub).toHaveBeenCalledWith(
        expect.objectContaining({
          properties: expect.objectContaining({
            toolName: "list_topics",
            durationMs: 100,
            status: "success",
          }),
        }),
      );
    });

    it("should include an error status for failed tool calls", () => {
      service.track(TelemetryEvent.TOOL_CALL, {
        toolName: "list_schemas",
        durationMs: 100,
        status: "error",
      });

      expect(trackStub).toHaveBeenCalledWith(
        expect.objectContaining({
          properties: expect.objectContaining({
            toolName: "list_schemas",
            durationMs: 100,
            status: "error",
          }),
        }),
      );
    });
  });
});
