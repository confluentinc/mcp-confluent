import { type DirectConnectionConfig } from "@src/config/index.js";
import { MCPServerConfiguration } from "@src/config/models.js";
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
  getToolHandlersToRegister,
  outputApiKey,
  outputToolList,
} from "@src/index.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { envFactory } from "@tests/factories/env.js";
import { createMockInstance } from "@tests/stubs/index.js";
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

function runtimeWith(env: ReturnType<typeof envFactory>): ServerRuntime {
  return new ServerRuntime(
    new MCPServerConfiguration({
      connections: { default: connWith({}) },
    }),
    { default: createMockInstance(DefaultClientManager) },
    env,
  );
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
        runtimeWith(
          envFactory({ KAFKA_API_KEY: "key", KAFKA_API_SECRET: "secret" }),
        ),
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
          runtimeWith(envFactory()), // no credentials
        ),
      ).toThrow("No tools enabled");
    });

    it("should exclude a tool absent from filteredToolNames even when env vars are present", () => {
      const getToolHandler = vi.spyOn(ToolHandlerRegistry, "getToolHandler");

      expect(() =>
        getToolHandlersToRegister(
          [], // LIST_TOPICS not in the allowed set
          false,
          runtimeWith(
            envFactory({ KAFKA_API_KEY: "key", KAFKA_API_SECRET: "secret" }),
          ),
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
          runtimeWith(
            envFactory({
              CONFLUENT_CLOUD_API_KEY: "key",
              CONFLUENT_CLOUD_API_SECRET: "secret",
            }),
          ),
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
        runtimeWith(
          envFactory({
            CONFLUENT_CLOUD_API_KEY: "key",
            CONFLUENT_CLOUD_API_SECRET: "secret",
          }),
        ),
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
        runtimeWith(
          envFactory({ KAFKA_API_KEY: "key", KAFKA_API_SECRET: "secret" }),
        ),
      );

      expect(result.has(ToolName.LIST_TOPICS)).toBe(true);
      expect(result.has(ToolName.CREATE_TOPICS)).toBe(false);
    });
  });

  describe("outputApiKey()", () => {
    // generateApiKey produces a 64-char hex string from 32 random bytes.
    // Stubbing the underlying randomBytes lets us assert deterministic output.
    const FAKE_BYTES = Buffer.alloc(32, 0xab);
    const EXPECTED_API_KEY = "ab".repeat(32);
    let randomBytesSpy: MockInstance<typeof nodeCrypto.randomBytes>;

    beforeEach(() => {
      randomBytesSpy = vi
        .spyOn(nodeCrypto, "randomBytes")
        .mockReturnValue(FAKE_BYTES);
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
