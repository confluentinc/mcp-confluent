import { DefaultClientManager } from "@src/confluent/client-manager.js";
import type {
  ToolConfig,
  ToolHandler,
} from "@src/confluent/tools/base-tools.js";
import { READ_ONLY } from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ToolHandlerRegistry } from "@src/confluent/tools/tool-registry.js";
import type { EnvVar } from "@src/env-schema.js";
import {
  constructDefaultClientManager,
  getToolHandlersToRegister,
  outputApiKey,
  outputToolList,
} from "@src/index.js";
import { generateApiKey } from "@src/mcp/transports/index.js";
import { cliOptionsFactory } from "@tests/factories/cli-options.js";
import { envFactory } from "@tests/factories/env.js";
import sinon from "sinon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// generateApiKey is an ESM live binding — must be mocked at the module level
// via vi.mock (hoisted by Vitest) so index.ts receives the mock on import.
vi.mock("@src/mcp/transports/index.js", () => ({
  generateApiKey: vi.fn(),
}));

function fakeHandler(requiredVars: EnvVar[], isCloudOnly = false): ToolHandler {
  return {
    getRequiredEnvVars: () => requiredVars,
    isConfluentCloudOnly: () => isCloudOnly,
    getToolConfig: () => ({
      name: ToolName.LIST_TOPICS,
      description: "test handler",
      inputSchema: {},
      annotations: READ_ONLY,
    }),
    handle: sinon.stub() as ToolHandler["handle"],
  };
}

describe("index.ts", () => {
  let sandbox: sinon.SinonSandbox;
  let consoleLog: sinon.SinonStub;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    consoleLog = sandbox.stub(console, "log");
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe("outputToolList()", () => {
    it("should not call console.log when the tool list is empty", () => {
      outputToolList([]);
      sinon.assert.notCalled(consoleLog);
    });

    it("should call console.log once for a single tool", () => {
      outputToolList([ToolName.LIST_TOPICS]);
      sinon.assert.calledOnce(consoleLog);
    });

    it("should call console.log once per tool for multiple tools", () => {
      outputToolList([
        ToolName.LIST_TOPICS,
        ToolName.CREATE_TOPICS,
        ToolName.DELETE_TOPICS,
      ]);
      sinon.assert.callCount(consoleLog, 3);
    });

    it("should include the tool name in the output line", () => {
      outputToolList([ToolName.LIST_TOPICS]);
      const output: string = consoleLog.firstCall.args[0];
      expect(output).toContain(ToolName.LIST_TOPICS);
    });

    it("should include the full description when it is within 120 characters", () => {
      const shortDesc = "A short description.";
      sandbox.stub(ToolHandlerRegistry, "getToolConfig").returns({
        name: ToolName.LIST_TOPICS,
        description: shortDesc,
        inputSchema: {},
        annotations: {},
      } as ToolConfig);

      outputToolList([ToolName.LIST_TOPICS]);

      const output: string = consoleLog.firstCall.args[0];
      expect(output).toContain(shortDesc);
      expect(output).not.toContain("...");
    });

    it("should truncate descriptions longer than 120 characters with ellipsis", () => {
      const longDesc = "x".repeat(150);
      sandbox.stub(ToolHandlerRegistry, "getToolConfig").returns({
        name: ToolName.LIST_TOPICS,
        description: longDesc,
        inputSchema: {},
        annotations: {},
      } as ToolConfig);

      outputToolList([ToolName.LIST_TOPICS]);

      const output: string = consoleLog.firstCall.args[0];
      expect(output).toContain("...");
      // ANSI codes only wrap the tool name before the ": " separator, so
      // splitting there isolates the description without needing regex stripping.
      const descPart = output.split(": ").slice(1).join(": ");
      expect(descPart.length).toBe(120);
    });
  });

  describe("getToolHandlersToRegister()", () => {
    it("should include a tool when all its required env vars are present", () => {
      sandbox
        .stub(ToolHandlerRegistry, "getToolHandler")
        .returns(fakeHandler(["KAFKA_API_KEY", "KAFKA_API_SECRET"]));

      const result = getToolHandlersToRegister(
        [ToolName.LIST_TOPICS],
        false,
        envFactory({ KAFKA_API_KEY: "key", KAFKA_API_SECRET: "secret" }),
      );

      expect(result.has(ToolName.LIST_TOPICS)).toBe(true);
    });

    it("should exclude a tool when a required env var is missing", () => {
      sandbox
        .stub(ToolHandlerRegistry, "getToolHandler")
        .returns(fakeHandler(["KAFKA_API_KEY", "KAFKA_API_SECRET"]));

      expect(() =>
        getToolHandlersToRegister(
          [ToolName.LIST_TOPICS],
          false,
          envFactory(), // no credentials
        ),
      ).toThrow("No tools enabled");
    });

    it("should exclude a tool absent from filteredToolNames even when env vars are present", () => {
      const getToolHandler = sandbox.stub(
        ToolHandlerRegistry,
        "getToolHandler",
      );

      expect(() =>
        getToolHandlersToRegister(
          [], // LIST_TOPICS not in the allowed set
          false,
          envFactory({ KAFKA_API_KEY: "key", KAFKA_API_SECRET: "secret" }),
        ),
      ).toThrow("No tools enabled");

      sinon.assert.notCalled(getToolHandler);
    });

    it("should exclude a cloud-only tool when disableConfluentCloudTools is true", () => {
      sandbox
        .stub(ToolHandlerRegistry, "getToolHandler")
        .returns(
          fakeHandler(
            ["CONFLUENT_CLOUD_API_KEY", "CONFLUENT_CLOUD_API_SECRET"],
            true,
          ),
        );

      expect(() =>
        getToolHandlersToRegister(
          [ToolName.LIST_TOPICS],
          true, // cloud tools disabled
          envFactory({
            CONFLUENT_CLOUD_API_KEY: "key",
            CONFLUENT_CLOUD_API_SECRET: "secret",
          }),
        ),
      ).toThrow("No tools enabled");
    });

    it("should include a cloud-only tool when disableConfluentCloudTools is false", () => {
      sandbox
        .stub(ToolHandlerRegistry, "getToolHandler")
        .returns(
          fakeHandler(
            ["CONFLUENT_CLOUD_API_KEY", "CONFLUENT_CLOUD_API_SECRET"],
            true,
          ),
        );

      const result = getToolHandlersToRegister(
        [ToolName.LIST_TOPICS],
        false,
        envFactory({
          CONFLUENT_CLOUD_API_KEY: "key",
          CONFLUENT_CLOUD_API_SECRET: "secret",
        }),
      );

      expect(result.has(ToolName.LIST_TOPICS)).toBe(true);
    });

    it("should include only the tool whose env vars are satisfied when tools have mixed satisfaction", () => {
      const getToolHandler = sandbox.stub(
        ToolHandlerRegistry,
        "getToolHandler",
      );
      getToolHandler
        .withArgs(ToolName.LIST_TOPICS)
        .returns(fakeHandler(["KAFKA_API_KEY", "KAFKA_API_SECRET"]));
      getToolHandler
        .withArgs(ToolName.CREATE_TOPICS)
        .returns(fakeHandler(["FLINK_API_KEY", "FLINK_API_SECRET"]));

      const result = getToolHandlersToRegister(
        [ToolName.LIST_TOPICS, ToolName.CREATE_TOPICS],
        false,
        envFactory({ KAFKA_API_KEY: "key", KAFKA_API_SECRET: "secret" }),
      );

      expect(result.has(ToolName.LIST_TOPICS)).toBe(true);
      expect(result.has(ToolName.CREATE_TOPICS)).toBe(false);
    });
  });

  describe("constructDefaultClientManager()", () => {
    it("should always set client.id to mcp-confluent", () => {
      const manager = constructDefaultClientManager(
        envFactory(),
        cliOptionsFactory(),
      );
      expect(manager["kafkaConfig"]["client.id"]).toBe("mcp-confluent");
    });

    it("should set bootstrap.servers from env", () => {
      const manager = constructDefaultClientManager(
        envFactory({ BOOTSTRAP_SERVERS: "broker:9092" }),
        cliOptionsFactory(),
      );
      expect(manager["kafkaConfig"]["bootstrap.servers"]).toBe("broker:9092");
    });

    it("should include SASL config when both KAFKA_API_KEY and KAFKA_API_SECRET are present", () => {
      const manager = constructDefaultClientManager(
        envFactory({
          KAFKA_API_KEY: "the-key",
          KAFKA_API_SECRET: "the-secret",
        }),
        cliOptionsFactory(),
      );
      expect(manager["kafkaConfig"]["security.protocol"]).toBe("sasl_ssl");
      expect(manager["kafkaConfig"]["sasl.username"]).toBe("the-key");
      expect(manager["kafkaConfig"]["sasl.password"]).toBe("the-secret");
    });

    it("should omit SASL config when KAFKA_API_KEY is absent", () => {
      const manager = constructDefaultClientManager(
        envFactory({ KAFKA_API_SECRET: "the-secret" }),
        cliOptionsFactory(),
      );
      expect(manager["kafkaConfig"]["security.protocol"]).toBeUndefined();
    });

    it("should omit SASL config when KAFKA_API_SECRET is absent", () => {
      const manager = constructDefaultClientManager(
        envFactory({ KAFKA_API_KEY: "the-key" }),
        cliOptionsFactory(),
      );
      expect(manager["kafkaConfig"]["security.protocol"]).toBeUndefined();
    });

    it("should omit SASL config when neither key nor secret is present", () => {
      const manager = constructDefaultClientManager(
        envFactory(),
        cliOptionsFactory(),
      );
      expect(manager["kafkaConfig"]["security.protocol"]).toBeUndefined();
    });

    it("should merge cliOptions.kafkaConfig last, overriding env-derived values", () => {
      const manager = constructDefaultClientManager(
        envFactory({ BOOTSTRAP_SERVERS: "from-env:9092" }),
        cliOptionsFactory({
          kafkaConfig: { "bootstrap.servers": "override:9092" },
        }),
      );
      expect(manager["kafkaConfig"]["bootstrap.servers"]).toBe("override:9092");
    });

    it("should map the cloud endpoint to confluentCloudBaseUrl", () => {
      const manager = constructDefaultClientManager(
        envFactory({ CONFLUENT_CLOUD_REST_ENDPOINT: "https://my.cloud.api" }),
        cliOptionsFactory(),
      );
      expect(manager["confluentCloudBaseUrl"]).toBe("https://my.cloud.api");
    });

    it("should use the telemetry endpoint default from env", () => {
      const manager = constructDefaultClientManager(
        envFactory(),
        cliOptionsFactory(),
      );
      expect(manager["confluentCloudTelemetryBaseUrl"]).toBe(
        "https://api.telemetry.confluent.cloud",
      );
    });

    it("should return a DefaultClientManager instance", () => {
      const manager = constructDefaultClientManager(
        envFactory(),
        cliOptionsFactory(),
      );
      expect(manager).toBeInstanceOf(DefaultClientManager);
    });
  });

  describe("outputApiKey()", () => {
    const FAKE_API_KEY = "fake-api-key-for-testing";

    beforeEach(() => {
      vi.mocked(generateApiKey).mockReturnValue(FAKE_API_KEY);
    });

    afterEach(() => {
      vi.mocked(generateApiKey).mockReset();
    });

    it("should call generateApiKey once", () => {
      outputApiKey();
      expect(vi.mocked(generateApiKey)).toHaveBeenCalledOnce();
    });

    it("should print the generated key to console.log", () => {
      outputApiKey();
      const allArgs: unknown[] = (console.log as sinon.SinonStub).args.flat();
      expect(allArgs).toContain(FAKE_API_KEY);
    });
  });
});
