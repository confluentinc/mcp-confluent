import { GetTopicConfigHandler } from "@src/confluent/tools/handlers/kafka/get-topic-config.js";
import {
  DEFAULT_CONNECTION_ID,
  HandleCaseWithConn,
  KAFKA_CONN,
  runtimeWith,
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
          label: "throws when clusterId is absent and not in connection config",
          args: { topicName: "my-topic" },
          outcome: { throws: "Kafka Cluster ID is required" },
          connectionConfig: {},
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
          clientManager
            .getConfluentCloudKafkaRestClient()
            .GET.mockResolvedValue({ data: {} });
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
        },
      );
    });
  });
});
