import { UpdateTableFlowTopicHandler } from "@src/confluent/tools/handlers/tableflow/topic/update-tableflow-topic-handler.js";
import {
  DEFAULT_CONNECTION_ID,
  runtimeWith,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  getMockedClientManager,
  type MockedRestClient,
} from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

const TOPIC_NAME = "my-topic";

const UPDATE_ARGS = {
  display_name: TOPIC_NAME,
  tableflowTopicConfig: {
    storage: {
      kind: "ByobAws",
      bucket_name: "my-bucket",
      provider_integration_id: "pi-abc123",
    },
    environment: { id: "env-abc123" },
    kafka_cluster: { id: "lkc-abc123", environment: "env-abc123" },
    config: {
      retention_ms: "6048000000",
      record_failure_strategy: "SUSPENDED",
    },
    table_formats: ["ICEBERG"],
  },
};

describe("update-tableflow-topic-handler.ts", () => {
  describe("UpdateTableFlowTopicHandler", () => {
    const handler = new UpdateTableFlowTopicHandler();

    describe("handle()", () => {
      // PATCH's openapi-fetch FetchResponse requires `response: Response` in every variant, and the
      // 200 success data is a complex generated intersection type. Satisfying either in a test
      // fixture is not worth the noise — the tests only care about the handler's branch logic.
      // The handler source has the same constraint and documents the same root cause.
      it("should resolve with an updated message on success", async () => {
        const clientManager = getMockedClientManager();
        clientManager
          .getConfluentCloudTableflowRestClient()
          .PATCH.mockResolvedValue(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            { data: { display_name: TOPIC_NAME } } as any,
          );
        await assertHandleCase({
          handler,
          runtime: runtimeWith({}, DEFAULT_CONNECTION_ID, clientManager),
          args: UPDATE_ARGS,
          outcome: { resolves: `Tableflow Topic ${TOPIC_NAME} updated` },
          clientManager,
        });
      });

      it("should resolve with an error message when the API returns an error", async () => {
        const clientManager = getMockedClientManager();
        clientManager
          .getConfluentCloudTableflowRestClient()
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .PATCH.mockResolvedValue({ error: { message: "not found" } } as any);
        await assertHandleCase({
          handler,
          runtime: runtimeWith({}, DEFAULT_CONNECTION_ID, clientManager),
          args: UPDATE_ARGS,
          outcome: {
            resolves: `Failed to update Tableflow topic for  ${TOPIC_NAME}`,
          },
          clientManager,
        });
      });

      it("should PATCH the correct topic and pass only environment.id in the body spec", async () => {
        const clientManager = getMockedClientManager();
        const tableflowRest: MockedRestClient =
          clientManager.getConfluentCloudTableflowRestClient();
        tableflowRest.PATCH.mockResolvedValue(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { data: { display_name: TOPIC_NAME } } as any,
        );
        await assertHandleCase({
          handler,
          runtime: runtimeWith({}, DEFAULT_CONNECTION_ID, clientManager),
          args: UPDATE_ARGS,
          outcome: { resolves: `Tableflow Topic ${TOPIC_NAME} updated` },
          clientManager,
        });
        expect(tableflowRest.PATCH).toHaveBeenCalledOnce();
        expect(tableflowRest.PATCH).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            params: expect.objectContaining({
              path: expect.objectContaining({ display_name: TOPIC_NAME }),
            }),
            body: expect.objectContaining({
              spec: expect.objectContaining({
                environment: { id: "env-abc123" },
                kafka_cluster: expect.objectContaining({
                  id: "lkc-abc123",
                  environment: "env-abc123",
                }),
              }),
            }),
          }),
        );
      });
    });
  });
});
