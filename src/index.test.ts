import { type DirectConnectionConfig } from "@src/config/index.js";
import { DefaultClientManager } from "@src/confluent/client-manager.js";
import { nodeCrypto } from "@src/confluent/node-deps.js";
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
import { envFactory } from "@tests/factories/env.js";
import {
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";

function connWith(
  fields: Omit<DirectConnectionConfig, "type">,
): DirectConnectionConfig {
  return { type: "direct", ...fields };
}

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
    handle: vi.fn() as unknown as ToolHandler["handle"],
  };
}

describe("index.ts", () => {
  let consoleLog: MockInstance<typeof console.log>;

  beforeEach(() => {
    consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  describe("outputToolList()", () => {
    it("should not call console.log when the tool list is empty", () => {
      outputToolList([]);
      expect(consoleLog).not.toHaveBeenCalled();
    });

    it("should call console.log once for a single tool", () => {
      outputToolList([ToolName.LIST_TOPICS]);
      expect(consoleLog).toHaveBeenCalledOnce();
    });

    it("should call console.log once per tool for multiple tools", () => {
      outputToolList([
        ToolName.LIST_TOPICS,
        ToolName.CREATE_TOPICS,
        ToolName.DELETE_TOPICS,
      ]);
      expect(consoleLog).toHaveBeenCalledTimes(3);
    });

    it("should include the tool name in the output line", () => {
      outputToolList([ToolName.LIST_TOPICS]);
      const output = consoleLog.mock.calls[0]![0] as string;
      expect(output).toContain(ToolName.LIST_TOPICS);
    });

    it("should include the full description when it is within 120 characters", () => {
      const shortDesc = "A short description.";
      vi.spyOn(ToolHandlerRegistry, "getToolConfig").mockReturnValue({
        name: ToolName.LIST_TOPICS,
        description: shortDesc,
        inputSchema: {},
        annotations: {},
      } as ToolConfig);

      outputToolList([ToolName.LIST_TOPICS]);

      const output = consoleLog.mock.calls[0]![0] as string;
      expect(output).toContain(shortDesc);
      expect(output).not.toContain("...");
    });

    it("should truncate descriptions longer than 120 characters with ellipsis", () => {
      const longDesc = "x".repeat(150);
      vi.spyOn(ToolHandlerRegistry, "getToolConfig").mockReturnValue({
        name: ToolName.LIST_TOPICS,
        description: longDesc,
        inputSchema: {},
        annotations: {},
      } as ToolConfig);

      outputToolList([ToolName.LIST_TOPICS]);

      const output = consoleLog.mock.calls[0]![0] as string;
      expect(output).toContain("...");
      // ANSI codes only wrap the tool name before the ": " separator, so
      // splitting there isolates the description without needing regex stripping.
      const descPart = output.split(": ").slice(1).join(": ");
      expect(descPart.length).toBe(120);
    });
  });

  describe("getToolHandlersToRegister()", () => {
    it("should include a tool when all its required env vars are present", () => {
      vi.spyOn(ToolHandlerRegistry, "getToolHandler").mockReturnValue(
        fakeHandler(["KAFKA_API_KEY", "KAFKA_API_SECRET"]),
      );

      const result = getToolHandlersToRegister(
        [ToolName.LIST_TOPICS],
        false,
        envFactory({ KAFKA_API_KEY: "key", KAFKA_API_SECRET: "secret" }),
      );

      expect(result.has(ToolName.LIST_TOPICS)).toBe(true);
    });

    it("should exclude a tool when a required env var is missing", () => {
      vi.spyOn(ToolHandlerRegistry, "getToolHandler").mockReturnValue(
        fakeHandler(["KAFKA_API_KEY", "KAFKA_API_SECRET"]),
      );

      expect(() =>
        getToolHandlersToRegister(
          [ToolName.LIST_TOPICS],
          false,
          envFactory(), // no credentials
        ),
      ).toThrow("No tools enabled");
    });

    it("should exclude a tool absent from filteredToolNames even when env vars are present", () => {
      const getToolHandler = vi.spyOn(ToolHandlerRegistry, "getToolHandler");

      expect(() =>
        getToolHandlersToRegister(
          [], // LIST_TOPICS not in the allowed set
          false,
          envFactory({ KAFKA_API_KEY: "key", KAFKA_API_SECRET: "secret" }),
        ),
      ).toThrow("No tools enabled");

      expect(getToolHandler).not.toHaveBeenCalled();
    });

    it("should exclude a cloud-only tool when disableConfluentCloudTools is true", () => {
      vi.spyOn(ToolHandlerRegistry, "getToolHandler").mockReturnValue(
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
      vi.spyOn(ToolHandlerRegistry, "getToolHandler").mockReturnValue(
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
      const listHandler = fakeHandler(["KAFKA_API_KEY", "KAFKA_API_SECRET"]);
      const createHandler = fakeHandler(["FLINK_API_KEY", "FLINK_API_SECRET"]);
      vi.spyOn(ToolHandlerRegistry, "getToolHandler").mockImplementation(
        (name) => {
          if (name === ToolName.LIST_TOPICS) return listHandler;
          if (name === ToolName.CREATE_TOPICS) return createHandler;
          throw new Error(`unexpected tool ${name}`);
        },
      );

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
    it("should return a DefaultClientManager instance", () => {
      const manager = constructDefaultClientManager(
        connWith({ kafka: { bootstrap_servers: "broker:9092" } }),
      );
      expect(manager).toBeInstanceOf(DefaultClientManager);
    });

    it("should always set client.id to mcp-confluent", () => {
      const manager = constructDefaultClientManager(
        connWith({ kafka: { bootstrap_servers: "broker:9092" } }),
      );
      expect(manager["kafkaConfig"]["client.id"]).toBe("mcp-confluent");
    });

    it("should set bootstrap.servers from the kafka block", () => {
      const manager = constructDefaultClientManager(
        connWith({ kafka: { bootstrap_servers: "broker:9092" } }),
      );
      expect(manager["kafkaConfig"]["bootstrap.servers"]).toBe("broker:9092");
    });

    it("should include SASL config when the kafka block has auth", () => {
      const manager = constructDefaultClientManager(
        connWith({
          kafka: {
            bootstrap_servers: "broker:9092",
            auth: { type: "api_key", key: "the-key", secret: "the-secret" },
          },
        }),
      );
      expect(manager["kafkaConfig"]["security.protocol"]).toBe("sasl_ssl");
      expect(manager["kafkaConfig"]["sasl.username"]).toBe("the-key");
      expect(manager["kafkaConfig"]["sasl.password"]).toBe("the-secret");
    });

    it("should omit SASL config when the kafka block has no auth", () => {
      const manager = constructDefaultClientManager(
        connWith({ kafka: { bootstrap_servers: "broker:9092" } }),
      );
      expect(manager["kafkaConfig"]["security.protocol"]).toBeUndefined();
    });

    it("should omit SASL config when there is no kafka block", () => {
      const manager = constructDefaultClientManager(
        connWith({
          confluent_cloud: {
            endpoint: "https://api.confluent.cloud",
            auth: { type: "api_key", key: "k", secret: "s" },
          },
        }),
      );
      expect(manager["kafkaConfig"]["security.protocol"]).toBeUndefined();
    });

    it("should spread kafka extra_properties into the GlobalConfig", () => {
      const manager = constructDefaultClientManager(
        connWith({
          kafka: {
            bootstrap_servers: "broker:9092",
            extra_properties: { "socket.timeout.ms": "5000" },
          },
        }),
      );
      expect(manager["kafkaConfig"]["socket.timeout.ms"]).toBe("5000");
    });

    it("should set confluentCloudBaseUrl from the confluent_cloud block endpoint", () => {
      const manager = constructDefaultClientManager(
        connWith({
          confluent_cloud: {
            endpoint: "https://my.cloud.api",
            auth: { type: "api_key", key: "k", secret: "s" },
          },
        }),
      );
      expect(manager["confluentCloudBaseUrl"]).toBe("https://my.cloud.api");
    });

    it("should set confluentCloudBaseUrl to https://api.confluent.cloud when the block uses the default endpoint", () => {
      const manager = constructDefaultClientManager(
        connWith({
          confluent_cloud: {
            endpoint: "https://api.confluent.cloud",
            auth: { type: "api_key", key: "k", secret: "s" },
          },
        }),
      );
      expect(manager["confluentCloudBaseUrl"]).toBe(
        "https://api.confluent.cloud",
      );
    });

    it("should default confluentCloudBaseUrl to https://api.confluent.cloud when there is no confluent_cloud block", () => {
      const manager = constructDefaultClientManager(
        connWith({ kafka: { bootstrap_servers: "broker:9092" } }),
      );
      expect(manager["confluentCloudBaseUrl"]).toBe(
        "https://api.confluent.cloud",
      );
    });

    it("should set confluentCloudTableflowBaseUrl to https://api.confluent.cloud when only tableflow is configured", () => {
      const manager = constructDefaultClientManager(
        connWith({
          tableflow: { auth: { type: "api_key", key: "k", secret: "s" } },
        }),
      );
      expect(manager["confluentCloudTableflowBaseUrl"]).toBe(
        "https://api.confluent.cloud",
      );
    });

    it("should set confluentCloudTelemetryBaseUrl from the telemetry block", () => {
      const manager = constructDefaultClientManager(
        connWith({
          telemetry: {
            endpoint: "https://my.telemetry.api",
            auth: { type: "api_key", key: "k", secret: "s" },
          },
        }),
      );
      expect(manager["confluentCloudTelemetryBaseUrl"]).toBe(
        "https://my.telemetry.api",
      );
    });

    it("should leave confluentCloudTelemetryBaseUrl undefined when there is no telemetry block", () => {
      const manager = constructDefaultClientManager(
        connWith({ kafka: { bootstrap_servers: "broker:9092" } }),
      );
      expect(manager["confluentCloudTelemetryBaseUrl"]).toBeUndefined();
    });
  });

  describe("outputApiKey()", () => {
    // generateApiKey produces a 64-char hex string from 32 random bytes.
    // Stubbing the underlying randomBytes lets us assert deterministic output.
    const FAKE_BYTES = Buffer.alloc(32, 0xab);
    const EXPECTED_API_KEY = "ab".repeat(32);
    // Narrow to the sync overload (size: number) => Buffer; the variadic
    // callback overload would type mockReturnValue's arg as void.
    let randomBytesSpy: MockInstance<(size: number) => Buffer>;

    beforeEach(() => {
      randomBytesSpy = vi.spyOn(
        nodeCrypto,
        "randomBytes",
      ) as unknown as MockInstance<(size: number) => Buffer>;
      randomBytesSpy.mockReturnValue(FAKE_BYTES);
    });

    it("should generate exactly one API key per invocation", () => {
      outputApiKey();
      expect(randomBytesSpy).toHaveBeenCalledOnce();
    });

    it("should print the generated key to console.log", () => {
      outputApiKey();
      const allArgs: unknown[] = consoleLog.mock.calls.flat();
      expect(allArgs).toContain(EXPECTED_API_KEY);
    });
  });
});
