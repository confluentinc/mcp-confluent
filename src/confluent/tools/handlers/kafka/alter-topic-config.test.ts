import { AlterTopicConfigHandler } from "@src/confluent/tools/handlers/kafka/alter-topic-config.js";
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

const VALID_CONFIGS = [
  { name: "retention.ms", value: "86400000", operation: "SET" as const },
];

describe("alter-topic-config.ts", () => {
  describe("AlterTopicConfigHandler", () => {
    const handler = new AlterTopicConfigHandler();

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
          args: { topicName: "my-topic", topicConfigs: VALID_CONFIGS },
          outcome: { throws: "Kafka Cluster ID is required" },
          connectionConfig: {},
        },
        {
          label:
            "uses cluster_id from connection config when clusterId arg is absent",
          args: { topicName: "my-topic", topicConfigs: VALID_CONFIGS },
          outcome: { resolves: "Successfully altered topic config" },
        },
        {
          label: "uses clusterId arg over connection config cluster_id",
          args: {
            topicName: "my-topic",
            topicConfigs: VALID_CONFIGS,
            clusterId: "lkc-from-args",
          },
          outcome: { resolves: "Successfully altered topic config" },
        },
      ];

      it.each(cases)(
        "should $label",
        async ({ args, outcome, connectionConfig = KAFKA_CONN }) => {
          const clientManager = getMockedClientManager();
          // handler POSTs to alter-configs and returns success on no error
          clientManager
            .getConfluentCloudKafkaRestClient()
            .POST.mockResolvedValue({ data: undefined });
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
