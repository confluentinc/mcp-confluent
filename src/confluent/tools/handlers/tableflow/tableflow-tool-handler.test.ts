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
  tableflowRuntime,
} from "@tests/factories/runtime.js";
import { describe, expect, it } from "vitest";

class StubTableflowHandler extends TableflowToolHandler {
  async handle(): Promise<CallToolResult> {
    return this.createResponse("stub");
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.LIST_TABLEFLOW_REGIONS,
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
      it("should return the connection ID for a tableflow-only connection", () => {
        expect(handler.enabledConnectionIds(tableflowRuntime())).toEqual([
          DEFAULT_CONNECTION_ID,
        ]);
      });

      it("should return the connection ID for a tableflow+kafka connection", () => {
        const conn: DirectConnectionConfig = {
          type: "direct",
          tableflow: { auth: { type: "api_key", key: "k", secret: "s" } },
          kafka: { rest_endpoint: "https://pkc-example.confluent.cloud:443" },
        };
        expect(handler.enabledConnectionIds(runtimeWith(conn))).toEqual([
          DEFAULT_CONNECTION_ID,
        ]);
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

      it("should use the env arg and fall back to config for cluster_id when only env arg is supplied", () => {
        expect(
          handler["resolveTableflowEnvAndClusterId"](
            connWithBoth,
            "env-from-arg",
            undefined,
          ),
        ).toEqual({
          environment_id: "env-from-arg",
          kafka_cluster_id: "lkc-from-config",
        });
      });

      it("should fall back to config for env_id and use the cluster arg when only cluster arg is supplied", () => {
        expect(
          handler["resolveTableflowEnvAndClusterId"](
            connWithBoth,
            undefined,
            "lkc-from-arg",
          ),
        ).toEqual({
          environment_id: "env-from-config",
          kafka_cluster_id: "lkc-from-arg",
        });
      });

      // The following two cases document intentional failure behaviour: the tool is
      // enabled on a tableflow-only connection (see enabledConnectionIds tests above),
      // but the handler throws when a required ID is absent from both the call arguments
      // and the connection config. Callers on such a connection must supply the missing
      // IDs as explicit arguments.
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
