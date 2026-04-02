import * as nodeDeps from "@src/confluent/node-deps.js";
import {
  FALLBACK_MACHINE_ID,
  TelemetryEvent,
  TelemetryService,
} from "@src/confluent/telemetry.js";
import sinon from "sinon";
import { afterEach, beforeEach, describe, it } from "vitest";

describe("TelemetryService", () => {
  let sandbox: sinon.SinonSandbox;

  let trackStub: sinon.SinonStub;
  let identifyStub: sinon.SinonStub;
  let closeAndFlushStub: sinon.SinonStub;
  let analyticsConstructorStub: sinon.SinonStub;
  let readFileSyncStub: sinon.SinonStub;
  let writeFileSyncStub: sinon.SinonStub;
  let mkdirSyncStub: sinon.SinonStub;
  let stubbedEnvVars: sinon.SinonStub;
  let stubbedBuildConfig: sinon.SinonStub;

  beforeEach(() => {
    sandbox = sinon.createSandbox();

    // analytics stubs (via wrapper for ESM compatibility)
    trackStub = sandbox.stub();
    identifyStub = sandbox.stub();
    closeAndFlushStub = sandbox.stub().resolves(undefined);
    analyticsConstructorStub = sandbox
      .stub(nodeDeps.segment, "Analytics")
      .returns({
        track: trackStub,
        identify: identifyStub,
        closeAndFlush: closeAndFlushStub,
      });

    // node builtin stubs (via wrapper for ESM compatibility)
    readFileSyncStub = sandbox
      .stub(nodeDeps.fs, "readFileSync")
      .throws(new Error("ENOENT"));
    writeFileSyncStub = sandbox.stub(nodeDeps.fs, "writeFileSync");
    mkdirSyncStub = sandbox.stub(nodeDeps.fs, "mkdirSync");
    sandbox.stub(nodeDeps.os, "homedir").returns("/tmp/test-home");

    // env stub (replaces Proxy that would throw before initEnv)
    stubbedEnvVars = sandbox.stub(nodeDeps.config, "env");
    stubbedEnvVars.value({ DO_NOT_TRACK: false });

    // default: no built-in write key (simulates unpacked/dev build)
    stubbedBuildConfig = sandbox.stub(
      nodeDeps.buildConfig,
      "TELEMETRY_WRITE_KEY",
    );
    stubbedBuildConfig.value("");

    TelemetryService["instance"] = undefined;
  });

  afterEach(() => {
    sandbox.restore();
    // not managed by the sandbox, so clean up manually to avoid affecting other tests
    delete process.env.TELEMETRY_WRITE_KEY;
  });

  describe("activation", () => {
    it("should be enabled when the TELEMETRY_WRITE_KEY env var is set", () => {
      process.env.TELEMETRY_WRITE_KEY = "real-key";

      const service = TelemetryService.getInstance();
      service.track(TelemetryEvent.TOOL_CALL, {
        toolName: "list_topics",
      });

      sinon.assert.calledOnce(trackStub);
    });

    it("should be enabled when the built-in write key is present (no env var)", () => {
      stubbedBuildConfig.value("packed-key");

      const service = TelemetryService.getInstance();
      service.track(TelemetryEvent.TOOL_CALL, {
        toolName: "list_topics",
      });

      sinon.assert.calledOnce(trackStub);
      sinon.assert.calledWith(
        analyticsConstructorStub,
        sinon.match({ writeKey: "packed-key" }),
      );
    });

    it("should prefer the env var over the built-in key", () => {
      process.env.TELEMETRY_WRITE_KEY = "env-key";
      stubbedBuildConfig.value("packed-key");

      const service = TelemetryService.getInstance();
      service.track(TelemetryEvent.TOOL_CALL, {
        toolName: "list_topics",
      });

      sinon.assert.calledOnce(trackStub);
      sinon.assert.calledWith(
        analyticsConstructorStub,
        sinon.match({ writeKey: "env-key" }),
      );
    });

    it("should be disabled when neither env var nor built-in key is set", () => {
      const service = TelemetryService.getInstance();
      service.track(TelemetryEvent.TOOL_CALL, {
        toolName: "list_topics",
      });

      sinon.assert.notCalled(trackStub);
    });

    it("should be disabled when DO_NOT_TRACK is true, even with a valid write key", () => {
      process.env.TELEMETRY_WRITE_KEY = "real-key";
      stubbedEnvVars.value({ DO_NOT_TRACK: true });

      const service = TelemetryService.getInstance();
      service.track(TelemetryEvent.TOOL_CALL, {
        toolName: "list_topics",
      });

      sinon.assert.notCalled(trackStub);
    });
  });

  describe("tracking", () => {
    let service: TelemetryService;

    beforeEach(() => {
      process.env.TELEMETRY_WRITE_KEY = "real-key";
      service = TelemetryService.getInstance();
    });

    it("should include event properties and machine ID as userId", () => {
      service.track(TelemetryEvent.TOOL_CALL, {
        toolName: "describe_topic",
        durationMs: 100,
      });

      sinon.assert.calledOnce(trackStub);
      sinon.assert.calledWith(
        trackStub,
        sinon.match({
          event: TelemetryEvent.TOOL_CALL,
          userId: sinon.match.string,
          properties: sinon.match({
            toolName: "describe_topic",
            durationMs: 100,
            serverSessionId: sinon.match.string,
            osPlatform: sinon.match.string,
            osVersion: sinon.match.string,
            osArch: sinon.match.string,
          }),
        }),
      );
    });

    it("should forward identify calls to the analytics client", () => {
      service.identify("user-123", { org: "acme" });

      sinon.assert.calledOnce(identifyStub);
      sinon.assert.calledWith(identifyStub, {
        userId: "user-123",
        traits: { org: "acme" },
      });
    });

    it("should skip identify calls when telemetry is disabled", () => {
      TelemetryService["instance"] = undefined;
      stubbedEnvVars.value({ DO_NOT_TRACK: true });

      const disabled = TelemetryService.getInstance();
      disabled.identify("user-123", { org: "acme" });

      sinon.assert.notCalled(identifyStub);
    });
  });

  describe("machine ID persistence", () => {
    it("should generate and write a new UUID when no machine-id file exists", () => {
      process.env.TELEMETRY_WRITE_KEY = "real-key";

      TelemetryService.getInstance();

      sinon.assert.calledOnce(writeFileSyncStub);
      sinon.assert.calledWith(
        writeFileSyncStub,
        sinon.match("machine-id"),
        sinon.match.string,
        sinon.match.any,
      );
    });

    it("should reuse an existing UUID when a machine-id file exists", () => {
      process.env.TELEMETRY_WRITE_KEY = "real-key";
      readFileSyncStub.returns("existing-uuid");

      const service = TelemetryService.getInstance();
      service.track(TelemetryEvent.TOOL_CALL, {});

      sinon.assert.calledWith(
        trackStub,
        sinon.match({ userId: "existing-uuid" }),
      );
    });

    it("should fall back to an anonymous ID when the file system is not writable", () => {
      process.env.TELEMETRY_WRITE_KEY = "real-key";
      mkdirSyncStub.throws(new Error("EACCES"));

      const service = TelemetryService.getInstance();
      service.track(TelemetryEvent.TOOL_CALL, {});

      sinon.assert.calledWith(
        trackStub,
        sinon.match({ userId: FALLBACK_MACHINE_ID }),
      );
    });
  });

  describe("shutdown", () => {
    it("should flush the analytics client on shutdown", async () => {
      process.env.TELEMETRY_WRITE_KEY = "real-key";

      await TelemetryService.getInstance().shutdown();

      sinon.assert.calledOnce(closeAndFlushStub);
      sinon.assert.calledWith(closeAndFlushStub, { timeout: 5000 });
    });

    it("should be a no-op when telemetry is disabled", async () => {
      await TelemetryService.getInstance().shutdown();

      sinon.assert.notCalled(closeAndFlushStub);
    });
  });

  describe("common properties", () => {
    let service: TelemetryService;

    beforeEach(() => {
      process.env.TELEMETRY_WRITE_KEY = "real-key";
      service = TelemetryService.getInstance();
    });

    it("should include OS info in every event", () => {
      service.track(TelemetryEvent.TOOL_CALL, { toolName: "test" });

      sinon.assert.calledWith(
        trackStub,
        sinon.match({
          properties: sinon.match({
            osPlatform: sinon.match.string,
            osVersion: sinon.match.string,
            osArch: sinon.match.string,
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

      sinon.assert.calledWith(
        trackStub,
        sinon.match({
          properties: sinon.match({
            serverVersion: "1.2.0",
            clientName: "claude-code",
            clientVersion: "2.1.87",
            osPlatform: sinon.match.string,
            serverSessionId: sinon.match.string,
          }),
        }),
      );
    });

    it("should allow per-event properties to override common properties", () => {
      service.setCommonProperties({ serverVersion: "1.0.0" });

      service.track(TelemetryEvent.TOOL_CALL, {
        serverVersion: "override",
      });

      sinon.assert.calledWith(
        trackStub,
        sinon.match({
          properties: sinon.match({ serverVersion: "override" }),
        }),
      );
    });
  });

  describe("tool call status", () => {
    let service: TelemetryService;

    beforeEach(() => {
      process.env.TELEMETRY_WRITE_KEY = "real-key";
      service = TelemetryService.getInstance();
    });

    it("should include a success status for successful tool calls", () => {
      service.track(TelemetryEvent.TOOL_CALL, {
        toolName: "list_topics",
        durationMs: 100,
        status: "success",
      });

      sinon.assert.calledWith(
        trackStub,
        sinon.match({
          properties: sinon.match({
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

      sinon.assert.calledWith(
        trackStub,
        sinon.match({
          properties: sinon.match({
            toolName: "list_schemas",
            durationMs: 100,
            status: "error",
          }),
        }),
      );
    });
  });

  describe("getInstance", () => {
    it("should return the same instance across multiple calls", () => {
      const a = TelemetryService.getInstance();
      const b = TelemetryService.getInstance();

      sinon.assert.match(a, b);
    });
  });
});
