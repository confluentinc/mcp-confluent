import { AlterTopicConfigHandler } from "@src/confluent/tools/handlers/kafka/alter-topic-config.js";
import {
  bareRuntime,
  DEFAULT_CONNECTION_ID,
  kafkaRestOnlyRuntime,
  kafkaRestRuntime,
  runtimeWith,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  stubClientGetters,
  type HandleCase,
} from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

const KAFKA_CONN = {
  kafka: {
    bootstrap_servers: "broker:9092",
    rest_endpoint: "https://kafka-rest.example.com",
    auth: { type: "api_key" as const, key: "k", secret: "s" },
    cluster_id: "lkc-from-config",
  },
};

const VALID_CONFIGS = [
  { name: "retention.ms", value: "86400000", operation: "SET" as const },
];

type HandleCaseWithConn = HandleCase & {
  connectionConfig?: Parameters<typeof runtimeWith>[0];
};

describe("alter-topic-config.ts", () => {
  describe("AlterTopicConfigHandler", () => {
    const handler = new AlterTopicConfigHandler();

    describe("enabledConnectionIds()", () => {
      it("should return the connection ID for a connection with kafka.rest_endpoint and auth", () => {
        expect(handler.enabledConnectionIds(kafkaRestRuntime())).toEqual([
          DEFAULT_CONNECTION_ID,
        ]);
      });

      it("should return an empty array for a connection without a kafka block", () => {
        expect(handler.enabledConnectionIds(bareRuntime())).toEqual([]);
      });

      it("should return an empty array for a kafka REST connection without auth", () => {
        expect(handler.enabledConnectionIds(kafkaRestOnlyRuntime())).toEqual(
          [],
        );
      });
    });

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
        async ({
          args,
          outcome,
          responseData,
          connectionConfig = KAFKA_CONN,
        }) => {
          const { clientManager, clientGetters } =
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
        },
      );
    });
  });
});
