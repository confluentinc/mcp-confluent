import { CallToolResult } from "@src/confluent/schema.js";
import { READ_ONLY, ToolConfig } from "@src/confluent/tools/base-tools.js";
import { ConnectToolHandler } from "@src/confluent/tools/handlers/connect/connect-tool-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { directConnectionOf } from "@tests/factories/config.js";
import { runtimeWith } from "@tests/factories/runtime.js";
import { describe, expect, it } from "vitest";

const CONNECT_CONN = {
  kafka: {
    env_id: "env-from-config",
    cluster_id: "lkc-from-config",
    rest_endpoint: "https://pkc-example.confluent.cloud:443",
  },
};

class StubConnectHandler extends ConnectToolHandler {
  async handle(): Promise<CallToolResult> {
    return this.createResponse("stub");
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.LIST_CONNECTORS,
      description: "stub",
      inputSchema: {},
      annotations: READ_ONLY,
    };
  }
}

describe("connect-tool-handler.ts", () => {
  describe("ConnectToolHandler", () => {
    const handler = new StubConnectHandler();

    describe("resolveConnectEnvAndClusterId()", () => {
      const resolveConnectEnvAndClusterId =
        handler["resolveConnectEnvAndClusterId"].bind(handler);

      it("should use arg values when both args and config are present", () => {
        const conn = directConnectionOf(runtimeWith(CONNECT_CONN).config);
        const result = resolveConnectEnvAndClusterId(
          conn,
          "env-from-arg",
          "lkc-from-arg",
        );
        expect(result.environment_id).toBe("env-from-arg");
        expect(result.kafka_cluster_id).toBe("lkc-from-arg");
      });

      it("should fall back to config values when args are absent", () => {
        const conn = directConnectionOf(runtimeWith(CONNECT_CONN).config);
        const result = resolveConnectEnvAndClusterId(
          conn,
          undefined,
          undefined,
        );
        expect(result.environment_id).toBe("env-from-config");
        expect(result.kafka_cluster_id).toBe("lkc-from-config");
      });

      it("should throw when environment_id is absent from both arg and config", () => {
        const conn = directConnectionOf(
          runtimeWith({
            kafka: {
              cluster_id: "lkc-from-config",
              rest_endpoint: "https://pkc-example.confluent.cloud:443",
            },
          }).config,
        );
        expect(() =>
          resolveConnectEnvAndClusterId(conn, undefined, "lkc-from-arg"),
        ).toThrow("Environment ID is required");
      });

      it("should throw when kafka_cluster_id is absent from both arg and config", () => {
        const conn = directConnectionOf(
          runtimeWith({
            kafka: {
              env_id: "env-from-config",
              rest_endpoint: "https://pkc-example.confluent.cloud:443",
            },
          }).config,
        );
        expect(() =>
          resolveConnectEnvAndClusterId(conn, "env-from-arg", undefined),
        ).toThrow("Kafka Cluster ID is required");
      });
    });
  });
});
