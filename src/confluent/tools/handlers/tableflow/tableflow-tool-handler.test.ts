import type { DirectConnectionConfig } from "@src/config/index.js";
import type { OAuthConnectionConfig } from "@src/config/models.js";
import type { CallToolResult } from "@src/confluent/schema.js";
import type { ToolConfig } from "@src/confluent/tools/base-tools.js";
import { READ_ONLY } from "@src/confluent/tools/base-tools.js";
import { TableflowToolHandler } from "@src/confluent/tools/handlers/tableflow/tableflow-tool-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
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

      // The following two cases pin intentional failure behaviour: a
      // tableflow-only connection satisfies the `hasTableflow` predicate (so
      // the tool is enabled), but `resolveTableflowEnvAndClusterId` throws
      // when a required ID is absent from both the call arguments and the
      // connection config. Callers on such a connection must supply the
      // missing IDs as explicit arguments.
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

      describe("under an OAuth connection", () => {
        const oauthConn: OAuthConnectionConfig = {
          type: "oauth",
          ccloud_env: "devel",
        };

        it("should use both args when present (no config fallback exists)", () => {
          expect(
            handler["resolveTableflowEnvAndClusterId"](
              oauthConn,
              "env-from-arg",
              "lkc-from-arg",
            ),
          ).toEqual({
            environment_id: "env-from-arg",
            kafka_cluster_id: "lkc-from-arg",
          });
        });

        it("should throw a discovery hint when environmentId is omitted", () => {
          expect(() =>
            handler["resolveTableflowEnvAndClusterId"](
              oauthConn,
              undefined,
              "lkc-from-arg",
            ),
          ).toThrow("required under OAuth connection type");
        });

        it("should throw a discovery hint when clusterId is omitted", () => {
          expect(() =>
            handler["resolveTableflowEnvAndClusterId"](
              oauthConn,
              "env-from-arg",
              undefined,
            ),
          ).toThrow("required under OAuth connection type");
        });
      });
    });
  });
});
