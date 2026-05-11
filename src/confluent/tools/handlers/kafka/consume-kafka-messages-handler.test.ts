import { ConsumeKafkaMessagesHandler } from "@src/confluent/tools/handlers/kafka/consume-kafka-messages-handler.js";
import {
  DEFAULT_CONNECTION_ID,
  runtimeWith,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  getMockedClientManager,
} from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

describe("consume-kafka-messages-handler.ts", () => {
  describe("ConsumeKafkaMessagesHandler", () => {
    const handler = new ConsumeKafkaMessagesHandler();

    describe("handle()", () => {
      it("should return an isError response when consumer.run rejects", async () => {
        // The outer `catch (error)` in the consume handler catches errors
        // from connect/subscribe/run and renders them via formatKafkaError.
        // Mocking `consumer.run` to reject reaches this branch directly.
        const clientManager = getMockedClientManager();
        const consumer = await clientManager.getConsumer();
        consumer.connect.mockResolvedValue(undefined);
        consumer.subscribe.mockResolvedValue(undefined);
        consumer.run.mockRejectedValue(new Error("group rebalance failed"));
        consumer.disconnect.mockResolvedValue(undefined);

        await assertHandleCase({
          handler,
          runtime: runtimeWith(
            { kafka: { bootstrap_servers: "broker:9092" } },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            topicNames: ["smoke"],
            maxMessages: 1,
            timeoutMs: 1000,
            value: {},
          },
          outcome: {
            resolves: "Failed to consume messages: group rebalance failed",
          },
          clientManager,
        });

        // Consumer must still be disconnected in the finally block even when
        // run() throws, so we don't leak the broker session.
        expect(consumer.disconnect).toHaveBeenCalledOnce();
      });

      it("should resolve with 0 messages when the timeout fires before any record arrives", async () => {
        // The handler's run-loop wraps `consumer.run({ eachMessage })` in a
        // Promise that resolves on either: (a) `maxMessages` records consumed,
        // or (b) `timeoutMs` elapsing. The mocked `consumer.run` resolves
        // immediately and never invokes `eachMessage`, so the test reaches
        // path (b) after the configured timeoutMs.
        const clientManager = getMockedClientManager();
        const consumer = await clientManager.getConsumer();
        consumer.connect.mockResolvedValue(undefined);
        consumer.subscribe.mockResolvedValue(undefined);
        consumer.run.mockResolvedValue(undefined);
        consumer.disconnect.mockResolvedValue(undefined);

        await assertHandleCase({
          handler,
          runtime: runtimeWith(
            { kafka: { bootstrap_servers: "broker:9092" } },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            topicNames: ["smoke"],
            maxMessages: 1,
            timeoutMs: 50,
            value: {},
          },
          outcome: { resolves: "Consumed 0 messages from topics smoke" },
          clientManager,
        });

        expect(consumer.subscribe).toHaveBeenCalledWith({
          topics: ["smoke"],
        });
        expect(consumer.disconnect).toHaveBeenCalledOnce();
      });

      it("should call getSchemaRegistrySdkClient with the resolved envId when value.useSchemaRegistry is true", async () => {
        // Pin the SR-under-OAuth wiring at the handler-test layer. Under
        // direct-mode runtime, `resolveKafkaClusterArgs` returns
        // `envId: undefined`, so the manager call is `(undefined)`. The
        // assertion is on the call shape, not message processing — the
        // mocked `consumer.run` resolves without invoking `eachMessage`.
        const clientManager = getMockedClientManager();
        const consumer = await clientManager.getConsumer();
        consumer.connect.mockResolvedValue(undefined);
        consumer.subscribe.mockResolvedValue(undefined);
        consumer.run.mockResolvedValue(undefined);
        consumer.disconnect.mockResolvedValue(undefined);

        await assertHandleCase({
          handler,
          runtime: runtimeWith(
            { kafka: { bootstrap_servers: "broker:9092" } },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            topicNames: ["smoke"],
            maxMessages: 1,
            timeoutMs: 50,
            value: { useSchemaRegistry: true },
          },
          outcome: { resolves: "Consumed 0 messages from topics smoke" },
          clientManager,
        });

        expect(clientManager.getSchemaRegistrySdkClient).toHaveBeenCalledWith(
          undefined,
        );
      });
    });
  });
});
