import { ReadTableFlowCatalogIntegrationHandler } from "@src/confluent/tools/handlers/tableflow/catalog/read-tableflow-catalog-integration-handler.js";
import {
  DEFAULT_CONNECTION_ID,
  runtimeWith,
  TABLEFLOW_CONN,
  TableflowHandleCase,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  getMockedClientManager,
} from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

const INTEGRATION_ID = "ci-abc123";

describe("read-tableflow-catalog-integration-handler.ts", () => {
  describe("ReadTableFlowCatalogIntegrationHandler", () => {
    const handler = new ReadTableFlowCatalogIntegrationHandler();

    describe("handle()", () => {
      const cases: TableflowHandleCase[] = [
        {
          label:
            "fall back to conn kafka env_id and cluster_id when args are absent",
          connectionConfig: TABLEFLOW_CONN,
          args: { id: INTEGRATION_ID },
          mockResponse: { data: { id: INTEGRATION_ID } },
          outcome: { resolves: "Tableflow catalog integration" },
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
          mockResponse: { data: { id: INTEGRATION_ID } },
          outcome: { resolves: "Tableflow catalog integration" },
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
          outcome: { throws: "Kafka Cluster ID is required" },
        },
        {
          label: "resolve with an error message when the API returns an error",
          connectionConfig: TABLEFLOW_CONN,
          args: { id: INTEGRATION_ID },
          mockResponse: { error: { message: "not found" } },
          outcome: {
            resolves: `Failed to read Tableflow catalog integration ${INTEGRATION_ID}`,
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
          mockResponse,
          outcome,
          expectedEnvId,
          expectedClusterId,
        }) => {
          const clientManager = getMockedClientManager();
          const tableflowRest =
            clientManager.getConfluentCloudTableflowRestClient();
          if (mockResponse !== undefined) {
            tableflowRest.GET.mockResolvedValue(mockResponse);
          }
          await assertHandleCase({
            handler,
            runtime: runtimeWith(
              connectionConfig,
              DEFAULT_CONNECTION_ID,
              clientManager,
            ),
            args,
            outcome,
            clientManager,
          });
          if (typeof outcome === "object" && "resolves" in outcome) {
            expect(tableflowRest.GET).toHaveBeenCalledWith(
              expect.any(String),
              expect.objectContaining({
                params: expect.objectContaining({
                  path: expect.objectContaining({
                    environment_id: expectedEnvId,
                    kafka_cluster_id: expectedClusterId,
                  }),
                }),
              }),
            );
          }
        },
      );
    });
  });
});
