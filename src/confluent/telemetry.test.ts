import { TelemetryEvent, TelemetryService } from "@src/confluent/telemetry.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mocks, these are referenced inside vi.mock factories, which vitest
// hoists above all imports. vi.hoisted ensures these variables exist at that point.
const { mockTrack, mockIdentify, mockCloseAndFlush, mockEnv } = vi.hoisted(
  () => ({
    mockTrack: vi.fn(),
    mockIdentify: vi.fn(),
    mockCloseAndFlush: vi.fn().mockResolvedValue(undefined),
    mockEnv: { DO_NOT_TRACK: false as boolean },
  }),
);

// Replaces the Analytics class with a stub whose methods we can assert on.
vi.mock("@segment/analytics-node", () => ({
  Analytics: class {
    track = mockTrack;
    identify = mockIdentify;
    closeAndFlush = mockCloseAndFlush;
  },
}));

// Controllable env object so tests can toggle DO_NOT_TRACK per scenario.
vi.mock("@src/env.js", () => ({ default: mockEnv }));

// Auto-mocked, tests control behavior via vi.mocked(readFileSync) etc.
vi.mock("node:fs");

// Static mocks, fixed return values, never inspected in tests.
vi.mock("@src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("node:crypto", () => ({ randomUUID: () => "generated-uuid" }));
vi.mock("node:os", () => ({
  homedir: () => "/tmp/test-home",
  platform: () => "darwin",
  release: () => "24.0.0",
  arch: () => "arm64",
}));

function createService(opts: { writeKey?: string; doNotTrack?: boolean } = {}) {
  if (opts.writeKey) process.env.TELEMETRY_WRITE_KEY = opts.writeKey;
  mockEnv.DO_NOT_TRACK = opts.doNotTrack ?? false;
  return TelemetryService.getInstance();
}

describe("TelemetryService", () => {
  beforeEach(() => {
    TelemetryService["instance"] = undefined;
    vi.clearAllMocks();
    // Default: no existing machine-id file on disk
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
  });

  afterEach(() => {
    delete process.env.TELEMETRY_WRITE_KEY;
  });

  describe("activation", () => {
    it("enables when env TELEMETRY_WRITE_KEY is a real key", () => {
      createService({ writeKey: "real-key" }).track(TelemetryEvent.TOOL_CALL, {
        toolName: "list_topics",
      });
      expect(mockTrack).toHaveBeenCalledOnce();
    });

    it("disables when TELEMETRY_WRITE_KEY is the unreplaced placeholder", () => {
      createService().track(TelemetryEvent.TOOL_CALL, {
        toolName: "list_topics",
      });
      expect(mockTrack).not.toHaveBeenCalled();
    });

    it("disables when DO_NOT_TRACK is true, even with a real write key", () => {
      createService({ writeKey: "real-key", doNotTrack: true }).track(
        TelemetryEvent.TOOL_CALL,
        { toolName: "list_topics" },
      );
      expect(mockTrack).not.toHaveBeenCalled();
    });
  });

  describe("tracking", () => {
    let service: TelemetryService;
    beforeEach(() => {
      service = createService({ writeKey: "real-key" });
    });

    it("sends event with properties and machine ID as userId", () => {
      service.track(TelemetryEvent.TOOL_CALL, {
        toolName: "describe_topic",
        durationMs: 42,
      });

      expect(mockTrack).toHaveBeenCalledWith({
        event: TelemetryEvent.TOOL_CALL,
        properties: expect.objectContaining({
          toolName: "describe_topic",
          durationMs: 42,
          serverSessionId: "generated-uuid",
          osPlatform: expect.any(String),
          osVersion: expect.any(String),
          osArch: expect.any(String),
        }),
        userId: "generated-uuid",
      });
    });

    it("forwards identify calls to analytics", () => {
      service.identify("user-123", { org: "acme" });
      expect(mockIdentify).toHaveBeenCalledWith({
        userId: "user-123",
        traits: { org: "acme" },
      });
    });

    it("is stopped for identify when disabled", () => {
      TelemetryService["instance"] = undefined;
      const disabled = createService({ doNotTrack: true });
      disabled.identify("user-123", { org: "acme" });
      expect(mockIdentify).not.toHaveBeenCalled();
    });
  });

  describe("machine ID persistence", () => {
    it("generates and persists a new UUID when no file exists", () => {
      createService({ writeKey: "real-key" });
      expect(vi.mocked(writeFileSync)).toHaveBeenCalledWith(
        expect.stringContaining("machine-id"),
        "generated-uuid",
        expect.anything(),
      );
    });

    it("reuses an existing UUID from the file", () => {
      vi.mocked(readFileSync).mockReturnValue("existing-uuid");
      createService({ writeKey: "real-key" }).track(
        TelemetryEvent.TOOL_CALL,
        {},
      );
      expect(mockTrack).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "existing-uuid" }),
      );
    });

    it("falls back to anonymous ID when file system is not writable", () => {
      vi.mocked(mkdirSync).mockImplementation(() => {
        throw new Error("EACCES");
      });
      createService({ writeKey: "real-key" }).track(
        TelemetryEvent.TOOL_CALL,
        {},
      );
      expect(mockTrack).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "mcp-confluent-anonymous" }),
      );
    });
  });

  describe("shutdown", () => {
    it("flushes analytics on shutdown", async () => {
      await createService({ writeKey: "real-key" }).shutdown();
      expect(mockCloseAndFlush).toHaveBeenCalledWith({ timeout: 5000 });
    });

    it("resolves cleanly when telemetry is disabled", async () => {
      await expect(createService().shutdown()).resolves.toBeUndefined();
      expect(mockCloseAndFlush).not.toHaveBeenCalled();
    });
  });

  describe("common properties", () => {
    let service: TelemetryService;
    beforeEach(() => {
      service = createService({ writeKey: "real-key" });
    });

    it("includes OS info in every track call", () => {
      service.track(TelemetryEvent.TOOL_CALL, { toolName: "test" });

      expect(mockTrack).toHaveBeenCalledWith(
        expect.objectContaining({
          properties: expect.objectContaining({
            osPlatform: "darwin",
            osVersion: "24.0.0",
            osArch: "arm64",
          }),
        }),
      );
    });

    it("merges additional common properties via setCommonProperties", () => {
      service.setCommonProperties({
        serverVersion: "1.2.0",
        clientName: "claude-code",
        clientVersion: "2.1.87",
      });

      service.track(TelemetryEvent.TOOL_CALL, { toolName: "test" });

      expect(mockTrack).toHaveBeenCalledWith(
        expect.objectContaining({
          properties: expect.objectContaining({
            serverVersion: "1.2.0",
            clientName: "claude-code",
            clientVersion: "2.1.87",
            osPlatform: "darwin",
            serverSessionId: "generated-uuid",
          }),
        }),
      );
    });

    it("per-event properties override common properties", () => {
      service.setCommonProperties({ serverVersion: "1.0.0" });

      service.track(TelemetryEvent.TOOL_CALL, {
        serverVersion: "override",
      });

      expect(mockTrack).toHaveBeenCalledWith(
        expect.objectContaining({
          properties: expect.objectContaining({
            serverVersion: "override",
          }),
        }),
      );
    });
  });

  describe("getInstance", () => {
    it("returns the same instance on repeated calls", () => {
      const a = createService({ writeKey: "real-key" });
      const b = TelemetryService.getInstance();
      expect(a).toBe(b);
    });
  });
});
