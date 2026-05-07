import { KafkaJS } from "@confluentinc/kafka-javascript";
import { CreateTopicsHandler } from "@src/confluent/tools/handlers/kafka/create-topics-handler.js";
import {
  bareRuntime,
  CCLOUD_OAUTH_CONNECTION_ID,
  ccloudOAuthRuntime,
  DEFAULT_CONNECTION_ID,
  kafkaRestOnlyRuntime,
  kafkaRuntime,
  runtimeWith,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  getMockedClientManager,
} from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

describe("create-topics-handler.ts", () => {
  describe("CreateTopicsHandler", () => {
    const handler = new CreateTopicsHandler();

    describe("enabledConnectionIds()", () => {
      it("should return the connection ID for a connection with kafka.bootstrap_servers", () => {
        expect(handler.enabledConnectionIds(kafkaRuntime())).toEqual([
          DEFAULT_CONNECTION_ID,
        ]);
      });

      it("should return an empty array for a connection without a kafka block", () => {
        expect(handler.enabledConnectionIds(bareRuntime())).toEqual([]);
      });

      it("should return an empty array for a kafka block without bootstrap_servers", () => {
        expect(handler.enabledConnectionIds(kafkaRestOnlyRuntime())).toEqual(
          [],
        );
      });

      it("should return the connection id when the connection is OAuth-typed", () => {
        expect(handler.enabledConnectionIds(ccloudOAuthRuntime())).toEqual([
          CCLOUD_OAUTH_CONNECTION_ID,
        ]);
      });
    });

    describe("handle()", () => {
      it("should report success when admin.createTopics resolves true", async () => {
        const clientManager = getMockedClientManager();
        const admin = await clientManager.getAdminClient();
        admin.createTopics.mockResolvedValue(true);

        await assertHandleCase({
          handler,
          runtime: runtimeWith(
            { kafka: { bootstrap_servers: "broker:9092" } },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: { topics: [{ topic: "smoke", numPartitions: 1 }] },
          outcome: { resolves: "Created Kafka topics: smoke" },
          clientManager,
        });
      });

      it("should surface a failure response when admin.createTopics resolves false", async () => {
        const clientManager = getMockedClientManager();
        const admin = await clientManager.getAdminClient();
        admin.createTopics.mockResolvedValue(false);

        await assertHandleCase({
          handler,
          runtime: runtimeWith(
            { kafka: { bootstrap_servers: "broker:9092" } },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: { topics: [{ topic: "smoke", numPartitions: 1 }] },
          outcome: { resolves: "Failed to create Kafka topics: smoke" },
          clientManager,
        });
      });

      it("should format Kafka errors via formatKafkaError when createTopics throws", async () => {
        const clientManager = getMockedClientManager();
        const admin = await clientManager.getAdminClient();
        admin.createTopics.mockRejectedValue(new Error("broker unavailable"));

        await assertHandleCase({
          handler,
          runtime: runtimeWith(
            { kafka: { bootstrap_servers: "broker:9092" } },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: { topics: [{ topic: "smoke", numPartitions: 1 }] },
          outcome: { resolves: "Failed to create Kafka topics" },
          clientManager,
        });
      });

      it("should unwrap KafkaJSAggregateError per-topic causes in the response", async () => {
        const clientManager = getMockedClientManager();
        const admin = await clientManager.getAdminClient();
        const aggregate = new KafkaJS.KafkaJSAggregateError(
          "Topic creation errors",
          [
            new KafkaJS.KafkaJSCreateTopicError(
              new KafkaJS.KafkaJSError("Authorization failed"),
              "topic-a",
            ),
            new KafkaJS.KafkaJSCreateTopicError(
              new KafkaJS.KafkaJSError("Topic already exists"),
              "topic-b",
            ),
          ],
        );
        admin.createTopics.mockRejectedValue(aggregate);

        await assertHandleCase({
          handler,
          runtime: runtimeWith(
            { kafka: { bootstrap_servers: "broker:9092" } },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            topics: [
              { topic: "topic-a", numPartitions: 1 },
              { topic: "topic-b", numPartitions: 1 },
            ],
          },
          outcome: { resolves: "topic-a: Authorization failed" },
          clientManager,
        });
      });
    });
  });
});
