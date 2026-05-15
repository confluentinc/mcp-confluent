import { KafkaJS } from "@confluentinc/kafka-javascript";
import { CreateTopicsHandler } from "@src/confluent/tools/handlers/kafka/create-topics-handler.js";
import {
  DEFAULT_CONNECTION_ID,
  runtimeWith,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  getMockedClientManager,
} from "@tests/stubs/index.js";
import { describe, it } from "vitest";

describe("create-topics-handler.ts", () => {
  describe("CreateTopicsHandler", () => {
    const handler = new CreateTopicsHandler();

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
