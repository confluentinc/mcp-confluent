import { GetTopicConfigHandler } from "@src/confluent/tools/handlers/kafka/get-topic-config.js";
import type { HandleCaseWithConn } from "@tests/factories/runtime.js";
import {
  DEFAULT_CONNECTION_ID,
  KAFKA_CONN,
  runtimeWithDecoy,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  getMockedClientManager,
} from "@tests/stubs/index.js";
import { describe, it } from "vitest";

describe("get-topic-config.ts", () => {
  describe("GetTopicConfigHandler", () => {
    const handler = new GetTopicConfigHandler();

    describe("handle()", () => {
      const cases: HandleCaseWithConn[] = [
        {
          label: "throws ZodError when topicName is absent",
          args: {},
          outcome: { throws: "ZodError" },
          connectionConfig: {},
        },
        {
          label:
            "throws when clusterId arg absent and conn.kafka.cluster_id missing",
          args: { topicName: "my-topic" },
          outcome: { throws: "clusterId is required" },
          connectionConfig: {
            kafka: {
              rest_endpoint: "https://kafka-rest.example.com",
              auth: { type: "api_key", key: "k", secret: "s" },
            },
          },
        },
        {
          label:
            "uses cluster_id from connection config when clusterId arg is absent",
          args: { topicName: "my-topic" },
          outcome: { resolves: "Topic configuration for 'my-topic'" },
        },
        {
          label: "uses clusterId arg over connection config cluster_id",
          args: { topicName: "my-topic", clusterId: "lkc-from-args" },
          outcome: { resolves: "Topic configuration for 'my-topic'" },
        },
      ];

      it.each(cases)(
        "should $label",
        async ({ args, outcome, connectionConfig = KAFKA_CONN }) => {
          const clientManager = getMockedClientManager();
          // handler does two GETs (topic details, then topic config) and stringifies the combined
          // result, so an empty object is fine here
          const restClient =
            await clientManager.getConfluentCloudKafkaRestClient();
          restClient.GET.mockResolvedValue({ data: {} });
          await assertHandleCase({
            handler,
            // runtimeWithDecoy plants a second same-config connection; assertHandleCase
            // routes to the real one and asserts the decoy stays untouched, so every
            // case here doubles as a routing test.
            runtime: runtimeWithDecoy(
              connectionConfig,
              DEFAULT_CONNECTION_ID,
              clientManager,
            ),
            args,
            outcome,
            clientManager,
          });
        },
      );
    });
  });
});
