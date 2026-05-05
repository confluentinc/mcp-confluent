import type { DirectConnectionConfig } from "@src/config/index.js";
import { CallToolResult } from "@src/confluent/schema.js";
import { READ_ONLY, ToolConfig } from "@src/confluent/tools/base-tools.js";
import { TableflowToolHandler } from "@src/confluent/tools/handlers/tableflow/tableflow-tool-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  bareRuntime,
  ccloudOAuthRuntime,
  DEFAULT_CONNECTION_ID,
  runtimeWith,
  TABLEFLOW_CONN,
  tableflowRuntime,
} from "@tests/factories/runtime.js";
import { describe, expect, it } from "vitest";

class StubTableflowHandler extends TableflowToolHandler {
  async handle(): Promise<CallToolResult> {
    return this.createResponse("stub");
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.LIST_TABLEFLOW_TOPICS,
      description: "stub",
      inputSchema: {},
      annotations: READ_ONLY,
    };
  }
}

describe("tableflow-tool-handler.ts", () => {
  describe("TableflowToolHandler", () => {
    const handler = new StubTableflowHandler();

    describe("enabledConnectionIds()", () => {
      it("should return the connection ID for a connection with tableflow and kafka blocks", () => {
        expect(
          handler.enabledConnectionIds(runtimeWith(TABLEFLOW_CONN)),
        ).toEqual([DEFAULT_CONNECTION_ID]);
      });

      it("should return an empty array for a tableflow-only connection without a kafka block", () => {
        expect(handler.enabledConnectionIds(tableflowRuntime())).toEqual([]);
      });

      it("should return an empty array for a connection without a tableflow block", () => {
        expect(handler.enabledConnectionIds(bareRuntime())).toEqual([]);
      });

      it("should return an empty array for an OAuth-typed connection", () => {
        expect(handler.enabledConnectionIds(ccloudOAuthRuntime())).toEqual([]);
      });
    });

    describe("resolveTableflowEnvAndClusterId()", () => {
      const connWithBoth: DirectConnectionConfig = {
        type: "direct",
        tableflow: { auth: { type: "api_key", key: "k", secret: "s" } },
        kafka: {
          env_id: "env-from-config",
          cluster_id: "lkc-from-config",
          rest_endpoint: "https://pkc-example.confluent.cloud:443",
        },
      };

      it("should prefer explicit args over connection config", () => {
        expect(
          handler["resolveTableflowEnvAndClusterId"](
            connWithBoth,
            "env-from-arg",
            "lkc-from-arg",
          ),
        ).toEqual({
          environment_id: "env-from-arg",
          kafka_cluster_id: "lkc-from-arg",
        });
      });

      it("should fall back to connection config when args are absent", () => {
        expect(
          handler["resolveTableflowEnvAndClusterId"](
            connWithBoth,
            undefined,
            undefined,
          ),
        ).toEqual({
          environment_id: "env-from-config",
          kafka_cluster_id: "lkc-from-config",
        });
      });

      it("should throw when environment_id is absent from both arg and config", () => {
        const connNoEnv: DirectConnectionConfig = {
          type: "direct",
          tableflow: { auth: { type: "api_key", key: "k", secret: "s" } },
          kafka: {
            cluster_id: "lkc-from-config",
            rest_endpoint: "https://pkc-example.confluent.cloud:443",
          },
        };
        expect(() =>
          handler["resolveTableflowEnvAndClusterId"](
            connNoEnv,
            undefined,
            undefined,
          ),
        ).toThrow("Environment ID is required");
      });

      it("should throw when kafka_cluster_id is absent from both arg and config", () => {
        const connNoCluster: DirectConnectionConfig = {
          type: "direct",
          tableflow: { auth: { type: "api_key", key: "k", secret: "s" } },
          kafka: {
            env_id: "env-from-config",
            rest_endpoint: "https://pkc-example.confluent.cloud:443",
          },
        };
        expect(() =>
          handler["resolveTableflowEnvAndClusterId"](
            connNoCluster,
            undefined,
            undefined,
          ),
        ).toThrow("Kafka Cluster ID is required");
      });
    });
  });
});
