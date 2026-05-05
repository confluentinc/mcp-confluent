import { UpdateTableFlowTopicHandler } from "@src/confluent/tools/handlers/tableflow/topic/update-tableflow-topic-handler.js";
import {
  bareRuntime,
  ccloudOAuthRuntime,
  DEFAULT_CONNECTION_ID,
  runtimeWith,
  tableflowRuntime,
} from "@tests/factories/runtime.js";
import { assertHandleCase, stubClientGetters } from "@tests/stubs/index.js";
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
      it("should resolve with an updated message on success", async () => {
        const { clientManager, clientGetters } = stubClientGetters({
          display_name: TOPIC_NAME,
        });
        await assertHandleCase({
          handler,
          runtime: runtimeWith({}, DEFAULT_CONNECTION_ID, clientManager),
          args: UPDATE_ARGS,
          outcome: { resolves: `Tableflow Topic ${TOPIC_NAME} updated` },
          clientGetters,
        });
      });

      it("should resolve with an error message when the API returns an error", async () => {
        const { clientManager } = stubClientGetters({
          error: { message: "not found" },
        });
        await assertHandleCase({
          handler,
          runtime: runtimeWith({}, DEFAULT_CONNECTION_ID, clientManager),
          args: UPDATE_ARGS,
          outcome: {
            resolves: `Failed to update Tableflow topic for  ${TOPIC_NAME}`,
          },
        });
      });

      it("should PATCH the correct topic and pass only environment.id in the body spec", async () => {
        const { clientManager, capturedCalls } = stubClientGetters({
          display_name: TOPIC_NAME,
        });
        await assertHandleCase({
          handler,
          runtime: runtimeWith({}, DEFAULT_CONNECTION_ID, clientManager),
          args: UPDATE_ARGS,
          outcome: { resolves: `Tableflow Topic ${TOPIC_NAME} updated` },
        });
        expect(capturedCalls).toHaveLength(1);
        expect(capturedCalls[0]!.args).toMatchObject({
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
        });
      });
    });
  });
});
