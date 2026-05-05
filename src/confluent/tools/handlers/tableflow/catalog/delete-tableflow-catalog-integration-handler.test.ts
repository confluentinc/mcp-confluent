import { DeleteTableFlowCatalogIntegrationHandler } from "@src/confluent/tools/handlers/tableflow/catalog/delete-tableflow-catalog-integration-handler.js";
import {
  bareRuntime,
  ccloudOAuthRuntime,
  DEFAULT_CONNECTION_ID,
  HandleCaseWithConn,
  runtimeWith,
  TABLEFLOW_CONN,
  tableflowRuntime,
} from "@tests/factories/runtime.js";
import { assertHandleCase, stubClientGetters } from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

type TableflowHandleCase = HandleCaseWithConn & {
  expectedEnvId?: string;
  expectedClusterId?: string;
};

const INTEGRATION_ID = "ci-abc123";

describe("delete-tableflow-catalog-integration-handler.ts", () => {
  describe("DeleteTableFlowCatalogIntegrationHandler", () => {
    const handler = new DeleteTableFlowCatalogIntegrationHandler();

    describe("enabledConnectionIds()", () => {
      it("should return the connection ID for a connection with a tableflow block", () => {
        expect(handler.enabledConnectionIds(tableflowRuntime())).toEqual([
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

    describe("handle()", () => {
      const cases: TableflowHandleCase[] = [
        {
          label:
            "fall back to conn kafka env_id and cluster_id when args are absent",
          connectionConfig: TABLEFLOW_CONN,
          args: { id: INTEGRATION_ID },
          responseData: {},
          outcome: {
            resolves: `Tableflow catalog integration ${INTEGRATION_ID} deleted`,
          },
          expectedEnvId: "env-from-config",
          expectedClusterId: "lkc-from-config",
        },
        {
          label:
            "prefer explicit environmentId and clusterId args over conn config",
          connectionConfig: TABLEFLOW_CONN,
          args: {
            id: INTEGRATION_ID,
            environmentId: "env-from-arg",
            clusterId: "lkc-from-arg",
          },
          responseData: {},
          outcome: {
            resolves: `Tableflow catalog integration ${INTEGRATION_ID} deleted`,
          },
          expectedEnvId: "env-from-arg",
          expectedClusterId: "lkc-from-arg",
        },
        {
          label: "throw when environment_id is absent from both arg and config",
          connectionConfig: {
            tableflow: {
              auth: { type: "api_key" as const, key: "k", secret: "s" },
            },
          },
          args: { id: INTEGRATION_ID },
          responseData: {},
          outcome: { throws: "Environment ID is required" },
        },
        {
          label:
            "throw when kafka_cluster_id is absent from both arg and config",
          connectionConfig: {
            tableflow: {
              auth: { type: "api_key" as const, key: "k", secret: "s" },
            },
            kafka: {
              env_id: "env-from-config",
              rest_endpoint: "https://pkc-example.confluent.cloud:443",
            },
          },
          args: { id: INTEGRATION_ID },
          responseData: {},
          outcome: { throws: "Kafka Cluster ID is required" },
        },
        {
          label: "resolve with an error message when the API returns an error",
          connectionConfig: TABLEFLOW_CONN,
          args: { id: INTEGRATION_ID },
          responseData: { error: { message: "not found" } },
          outcome: {
            resolves: `Failed to delete Tableflow catalog integration ${INTEGRATION_ID}`,
          },
          expectedEnvId: "env-from-config",
          expectedClusterId: "lkc-from-config",
        },
      ];

      it.each(cases)(
        "should $label",
        async ({
          connectionConfig = {},
          args,
          responseData,
          outcome,
          expectedEnvId,
          expectedClusterId,
        }) => {
          const { clientManager, clientGetters, capturedCalls } =
            stubClientGetters(responseData);
          await assertHandleCase({
            handler,
            runtime: runtimeWith(
              connectionConfig,
              DEFAULT_CONNECTION_ID,
              clientManager,
            ),
            args,
            outcome,
            clientGetters,
          });
          if (typeof outcome === "object" && "resolves" in outcome) {
            expect(capturedCalls).toHaveLength(1);
            expect(capturedCalls[0]!.args).toMatchObject({
              params: expect.objectContaining({
                path: expect.objectContaining({
                  environment_id: expectedEnvId,
                  kafka_cluster_id: expectedClusterId,
                }),
              }),
            });
          }
        },
      );
    });
  });
});
