import { ProduceKafkaMessageHandler } from "@src/confluent/tools/handlers/kafka/produce-kafka-message-handler.js";
import {
  bareRuntime,
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

describe("produce-kafka-message-handler.ts", () => {
  describe("ProduceKafkaMessageHandler", () => {
    const handler = new ProduceKafkaMessageHandler();

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
          DEFAULT_CONNECTION_ID,
        ]);
      });
    });

    describe("handle()", () => {
      it("should report success offset metadata when producer.send resolves", async () => {
        const clientManager = getMockedClientManager();
        const producer = await clientManager.getProducer();
        producer.send.mockResolvedValue([
          {
            topicName: "smoke",
            partition: 0,
            offset: "5",
            errorCode: 0,
          },
        ]);

        await assertHandleCase({
          handler,
          runtime: runtimeWith(
            { kafka: { bootstrap_servers: "broker:9092" } },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            topicName: "smoke",
            value: { message: "hello", useSchemaRegistry: false },
          },
          outcome: {
            resolves: "Message produced successfully to [Topic: smoke",
          },
          clientManager,
        });
      });

      it("should return an isError response when producer.send throws", async () => {
        const clientManager = getMockedClientManager();
        const producer = await clientManager.getProducer();
        producer.send.mockRejectedValue(new Error("connection lost"));

        await assertHandleCase({
          handler,
          runtime: runtimeWith(
            { kafka: { bootstrap_servers: "broker:9092" } },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            topicName: "smoke",
            value: { message: "hello", useSchemaRegistry: false },
          },
          outcome: { resolves: "Failed to produce message: connection lost" },
          clientManager,
        });
      });

      it("should report a per-record error when delivery report has a non-zero errorCode", async () => {
        const clientManager = getMockedClientManager();
        const producer = await clientManager.getProducer();
        producer.send.mockResolvedValue([
          {
            topicName: "smoke",
            partition: 0,
            offset: "5",
            errorCode: 2,
          },
        ]);

        await assertHandleCase({
          handler,
          runtime: runtimeWith(
            { kafka: { bootstrap_servers: "broker:9092" } },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            topicName: "smoke",
            value: { message: "hello", useSchemaRegistry: false },
          },
          outcome: { resolves: "Error producing message to [Topic: smoke" },
          clientManager,
        });
      });
    });
  });
});
