import { CreateTableFlowCatalogIntegrationHandler } from "@src/confluent/tools/handlers/tableflow/catalog/create-tableflow-catalog-integration-handler.js";
import {
  bareRuntime,
  ccloudOAuthRuntime,
  DEFAULT_CONNECTION_ID,
  HandleCaseWithConn,
  runtimeWith,
  TABLEFLOW_CONN,
  tableflowRuntime,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  getMockedClientManager,
} from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

type TableflowHandleCase = HandleCaseWithConn & {
  mockResponse?: { data?: unknown; error?: unknown };
  expectedEnvId?: string;
  expectedClusterId?: string;
};

const MINIMAL_CREATE_ARGS = {
  environmentId: undefined,
  clusterId: undefined,
  tableflowCatalogIntegrationConfig: {
    display_name: "my-catalog",
    config: {
      kind: "AwsGlue",
      provider_integration_id: "pi-abc123",
    },
  },
};

describe("create-tableflow-catalog-integration-handler.ts", () => {
  describe("CreateTableFlowCatalogIntegrationHandler", () => {
    const handler = new CreateTableFlowCatalogIntegrationHandler();

    describe("enabledConnectionIds()", () => {
      it("should return the connection ID for a connection with tableflow and kafka blocks", () => {
        expect(
          handler.enabledConnectionIds(runtimeWith(TABLEFLOW_CONN)),
        ).toEqual([DEFAULT_CONNECTION_ID]);
      });

      it("should return the connection ID for a tableflow-only connection without a kafka block", () => {
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
          args: MINIMAL_CREATE_ARGS,
          mockResponse: { data: { display_name: "my-catalog" } },
          outcome: {
            resolves: "Tableflow Catalog Integration my-catalog created",
          },
          expectedEnvId: "env-from-config",
          expectedClusterId: "lkc-from-config",
        },
        {
          label:
            "prefer explicit environmentId and clusterId args over conn config",
          connectionConfig: TABLEFLOW_CONN,
          args: {
            ...MINIMAL_CREATE_ARGS,
            environmentId: "env-from-arg",
            clusterId: "lkc-from-arg",
          },
          mockResponse: { data: { display_name: "my-catalog" } },
          outcome: {
            resolves: "Tableflow Catalog Integration my-catalog created",
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
          args: MINIMAL_CREATE_ARGS,
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
          args: MINIMAL_CREATE_ARGS,
          outcome: { throws: "Kafka Cluster ID is required" },
        },
        {
          label: "resolve with an error message when the API returns an error",
          connectionConfig: TABLEFLOW_CONN,
          args: MINIMAL_CREATE_ARGS,
          mockResponse: { error: { message: "conflict" } },
          outcome: {
            resolves:
              "Failed to create Tableflow Catalog Integration for  my-catalog",
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
            tableflowRest.POST.mockResolvedValue(mockResponse);
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
            expect(tableflowRest.POST).toHaveBeenCalledWith(
              expect.any(String),
              expect.objectContaining({
                body: expect.objectContaining({
                  spec: expect.objectContaining({
                    environment: expect.objectContaining({ id: expectedEnvId }),
                    kafka_cluster: expect.objectContaining({
                      id: expectedClusterId,
                    }),
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
