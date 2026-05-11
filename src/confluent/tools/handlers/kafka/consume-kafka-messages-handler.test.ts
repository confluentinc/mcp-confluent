import type { KafkaMessage } from "@confluentinc/kafka-javascript/types/kafkajs.js";
import type { SchemaRegistryClient } from "@confluentinc/schemaregistry";
import { ConsumeKafkaMessagesHandler } from "@src/confluent/tools/handlers/kafka/consume-kafka-messages-handler.js";
import {
  DEFAULT_CONNECTION_ID,
  runtimeWith,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  getMockedClientManager,
} from "@tests/stubs/index.js";
import { describe, expect, it, vi } from "vitest";

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
    });

    describe("processMessage()", () => {
      // The registry mock makes `getLatestSchemaMetadata` reject with a 404,
      // which `getLatestSchemaIfExists` translates to `null` → processMessage
      // falls through to raw bytes. This lets each test assert ONLY whether
      // the subject lookup was attempted (the boundary decision under test),
      // without faking an SR deserializer for the success path.
      const notFound = { status: 404 };
      const buildRegistry = (): {
        registry: SchemaRegistryClient;
        getLatestSchemaMetadata: ReturnType<typeof vi.fn>;
      } => {
        const getLatestSchemaMetadata = vi.fn().mockRejectedValue(notFound);
        return {
          registry: {
            getLatestSchemaMetadata,
          } as unknown as SchemaRegistryClient,
          getLatestSchemaMetadata,
        };
      };

      const buildMessage = (
        opts: { key?: Buffer; value?: Buffer } = {},
      ): KafkaMessage =>
        ({
          key: opts.key,
          value: opts.value ?? Buffer.from("v"),
          timestamp: "1700000000000",
          offset: "42",
          headers: undefined,
          attributes: 0,
        }) as unknown as KafkaMessage;

      it("should skip the value subject lookup when value opts out explicitly", async () => {
        const { registry, getLatestSchemaMetadata } = buildRegistry();
        const result = await handler.processMessage(
          "t",
          0,
          buildMessage(),
          registry,
          { useSchemaRegistry: false },
        );
        expect(result.value).toBe("v");
        expect(getLatestSchemaMetadata).not.toHaveBeenCalled();
      });

      it("should attempt the value subject lookup when useSchemaRegistry is omitted (tri-state auto-decode path)", async () => {
        const { registry, getLatestSchemaMetadata } = buildRegistry();
        const result = await handler.processMessage(
          "t",
          0,
          buildMessage(),
          registry,
          {},
        );
        expect(result.value).toBe("v");
        expect(getLatestSchemaMetadata).toHaveBeenCalledOnce();
        expect(getLatestSchemaMetadata).toHaveBeenCalledWith("t-value");
      });

      it("should attempt the key subject lookup when keyOptions is omitted entirely (auto-decode-when-absent path)", async () => {
        const { registry, getLatestSchemaMetadata } = buildRegistry();
        const result = await handler.processMessage(
          "t",
          0,
          buildMessage({ key: Buffer.from("k") }),
          registry,
          { useSchemaRegistry: false }, // value opt-out isolates the key path
        );
        expect(result.key).toBe("k");
        expect(getLatestSchemaMetadata).toHaveBeenCalledOnce();
        expect(getLatestSchemaMetadata).toHaveBeenCalledWith("t-key");
      });

      it("should skip the key subject lookup when key opts out explicitly", async () => {
        const { registry, getLatestSchemaMetadata } = buildRegistry();
        const result = await handler.processMessage(
          "t",
          0,
          buildMessage({ key: Buffer.from("k") }),
          registry,
          { useSchemaRegistry: false },
          { useSchemaRegistry: false },
        );
        expect(result.key).toBe("k");
        expect(getLatestSchemaMetadata).not.toHaveBeenCalled();
      });
    });
  });
});
