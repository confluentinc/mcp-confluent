import { GetTopicConfigHandler } from "@src/confluent/tools/handlers/kafka/get-topic-config.js";
import {
  DEFAULT_CONNECTION_ID,
  HandleCaseWithConn,
  KAFKA_CONN,
  runtimeWith,
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

      it("should route to the explicitly addressed connection in a multi-connection config", async () => {
        const clientManager = getMockedClientManager();
        const restClient =
          await clientManager.getConfluentCloudKafkaRestClient();
        restClient.GET.mockResolvedValue({ data: {} });

        const { runtime, decoyClientManager } = runtimeWithDecoy(
          KAFKA_CONN,
          DEFAULT_CONNECTION_ID,
          clientManager,
        );

        await assertHandleCase({
          handler,
          runtime,
          args: { topicName: "my-topic", connectionId: DEFAULT_CONNECTION_ID },
          outcome: { resolves: "Topic configuration for 'my-topic'" },
          clientManager,
          untouchedClientManager: decoyClientManager,
        });
      });
    });
  });
});
