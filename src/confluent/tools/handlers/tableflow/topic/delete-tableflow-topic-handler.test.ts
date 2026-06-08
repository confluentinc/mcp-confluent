import { DeleteTableFlowTopicHandler } from "@src/confluent/tools/handlers/tableflow/topic/delete-tableflow-topic-handler.js";
import {
  DEFAULT_CONNECTION_ID,
  runtimeWithDecoy,
  TABLEFLOW_CONN,
  TableflowHandleCase,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  getMockedClientManager,
} from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

const TOPIC_NAME = "my-topic";

describe("delete-tableflow-topic-handler.ts", () => {
  describe("DeleteTableFlowTopicHandler", () => {
    const handler = new DeleteTableFlowTopicHandler();

    describe("handle()", () => {
      const cases: TableflowHandleCase[] = [
        {
          label:
            "fall back to conn kafka env_id and cluster_id when args are absent",
          connectionConfig: TABLEFLOW_CONN,
          args: { display_name: TOPIC_NAME },
          mockResponse: {},
          outcome: { resolves: `Tableflow Topic ${TOPIC_NAME} deleted` },
          expectedEnvId: "env-from-config",
          expectedClusterId: "lkc-from-config",
        },
        {
          label:
            "prefer explicit environmentId and clusterId args over conn config",
          connectionConfig: TABLEFLOW_CONN,
          args: {
            display_name: TOPIC_NAME,
            environmentId: "env-from-arg",
            clusterId: "lkc-from-arg",
          },
          mockResponse: {},
          outcome: { resolves: `Tableflow Topic ${TOPIC_NAME} deleted` },
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
          args: { display_name: TOPIC_NAME },
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
          args: { display_name: TOPIC_NAME },
          outcome: { throws: "Kafka Cluster ID is required" },
        },
        {
          label: "resolve with an error message when the API returns an error",
          connectionConfig: TABLEFLOW_CONN,
          args: { display_name: TOPIC_NAME },
          mockResponse: { error: { message: "not found" } },
          outcome: {
            resolves: `Failed to delete Tableflow topic ${TOPIC_NAME}`,
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
            tableflowRest.DELETE.mockResolvedValue(mockResponse);
          }
          await assertHandleCase({
            handler,
            runtime: runtimeWithDecoy(
              connectionConfig,
              DEFAULT_CONNECTION_ID,
              clientManager,
            ),
            args,
            outcome,
            clientManager,
          });
          if (typeof outcome === "object" && "resolves" in outcome) {
            expect(tableflowRest.DELETE).toHaveBeenCalledWith(
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
