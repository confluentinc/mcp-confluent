import * as nodeDeps from "@src/confluent/node-deps.js";
import { TelemetryEvent, TelemetryService } from "@src/confluent/telemetry.js";
import sinon from "sinon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const STUB_UUID = "00000000-0000-0000-0000-000000000000";

describe("TelemetryService", () => {
  let sandbox: sinon.SinonSandbox;

  let trackStub: sinon.SinonStub;
  let identifyStub: sinon.SinonStub;
  let closeAndFlushStub: sinon.SinonStub;
  let readFileSyncStub: sinon.SinonStub;
  let writeFileSyncStub: sinon.SinonStub;
  let mkdirSyncStub: sinon.SinonStub;
  let stubbedEnvVars: sinon.SinonStub;

  beforeEach(() => {
    sandbox = sinon.createSandbox();

    // analytics stubs (via wrapper for ESM compatibility)
    trackStub = sandbox.stub();
    identifyStub = sandbox.stub();
    closeAndFlushStub = sandbox.stub().resolves(undefined);
    sandbox.stub(nodeDeps.segment, "Analytics").returns({
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
    sandbox.stub(nodeDeps.crypto, "randomUUID").returns(STUB_UUID);

    // env stub (replaces Proxy that would throw before initEnv)
    stubbedEnvVars = sandbox.stub(nodeDeps.config, "env");
    stubbedEnvVars.value({ DO_NOT_TRACK: false });

    TelemetryService["instance"] = undefined;
  });

  afterEach(() => {
    sandbox.restore();
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

    it("should be disabled when TELEMETRY_WRITE_KEY is the unreplaced placeholder", () => {
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
        durationMs: 42,
      });

      sinon.assert.calledOnce(trackStub);
      sinon.assert.calledWith(
        trackStub,
        sinon.match({
          event: TelemetryEvent.TOOL_CALL,
          userId: STUB_UUID,
          properties: sinon.match({
            toolName: "describe_topic",
            durationMs: 42,
            serverSessionId: STUB_UUID,
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
        STUB_UUID,
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
        sinon.match({ userId: "mcp-confluent-anonymous" }),
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
            serverSessionId: STUB_UUID,
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

  describe("error tracking", () => {
    let service: TelemetryService;

    beforeEach(() => {
      process.env.TELEMETRY_WRITE_KEY = "real-key";
      service = TelemetryService.getInstance();
    });

    it("should include error type and message for failed tool calls", () => {
      service.track(TelemetryEvent.TOOL_CALL, {
        toolName: "list_schemas",
        durationMs: 150,
        isError: true,
        errorType: "TypeError",
        errorMessage: "Cannot read properties of undefined",
      });

      sinon.assert.calledWith(
        trackStub,
        sinon.match({
          event: TelemetryEvent.TOOL_CALL,
          properties: sinon.match({
            toolName: "list_schemas",
            durationMs: 150,
            isError: true,
            errorType: "TypeError",
            errorMessage: "Cannot read properties of undefined",
          }),
        }),
      );
    });

    it("should include isError and errorMessage for API failures", () => {
      service.track(TelemetryEvent.TOOL_CALL, {
        toolName: "list_schemas",
        durationMs: 200,
        isError: true,
        errorMessage: "Failed to list schemas: Request failed with status 401",
      });

      sinon.assert.calledWith(
        trackStub,
        sinon.match({
          event: TelemetryEvent.TOOL_CALL,
          properties: sinon.match({
            toolName: "list_schemas",
            isError: true,
            errorMessage:
              "Failed to list schemas: Request failed with status 401",
          }),
        }),
      );
    });

    it("should omit error fields for successful calls", () => {
      service.track(TelemetryEvent.TOOL_CALL, {
        toolName: "list_topics",
        durationMs: 50,
        isError: false,
      });

      const props = trackStub.firstCall.args[0].properties;
      sinon.assert.match(props, { isError: false });
      expect(props.errorType).toBeUndefined();
      expect(props.errorMessage).toBeUndefined();
    });
  });

  describe("getInstance", () => {
    it("should return the same instance across multiple calls", () => {
      process.env.TELEMETRY_WRITE_KEY = "real-key";

      const a = TelemetryService.getInstance();
      const b = TelemetryService.getInstance();

      sinon.assert.match(a, b);
    });
  });
});
