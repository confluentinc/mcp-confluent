import { ProduceKafkaMessageHandler } from "@src/confluent/tools/handlers/kafka/produce-kafka-message-handler.js";
import { DEFAULT_CONNECTION_ID } from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  getMockedClientManager,
} from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

describe("produce-kafka-message-handler.ts", () => {
  describe("ProduceKafkaMessageHandler", () => {
    const handler = new ProduceKafkaMessageHandler();

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
          runtime: runtimeWithDecoy(
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
          runtime: runtimeWithDecoy(
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
          runtime: runtimeWithDecoy(
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

      it("should throw a ZodError when a PROTOBUF value omits messageName", async () => {
        // The valueOptions superRefine requires messageName for PROTOBUF
        // produces that use schema registry; without it the schema rejects
        // before the handler touches the client.
        const clientManager = getMockedClientManager();
        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            { kafka: { bootstrap_servers: "broker:9092" } },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            topicName: "smoke",
            value: {
              message: { user_id: "USR-001" },
              useSchemaRegistry: true,
              schemaType: "PROTOBUF",
            },
          },
          outcome: { throws: "ZodError" },
        });
      });

      it("should call getSchemaRegistrySdkClient with the resolved envId when value.useSchemaRegistry is true", async () => {
        // Pin the SR-under-OAuth wiring at the handler-test layer. Under
        // direct-mode runtime, `resolveKafkaClusterArgs` returns
        // `envId: undefined`, so the manager call is `(undefined)`. The
        // assertion is on the call shape, not the outcome — the handler
        // is allowed to short-circuit on the schema-missing path.
        const clientManager = getMockedClientManager();
        // Make subject lookup miss → checkSchemaNeeded returns "no-schema"
        // → handler returns an isError response without invoking the
        // producer or serializer. Cheap controlled exit.
        clientManager
          .getSchemaRegistryClient()
          .getLatestSchemaMetadata.mockRejectedValue({ status: 404 });

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            { kafka: { bootstrap_servers: "broker:9092" } },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            topicName: "smoke",
            value: { message: { x: 1 }, useSchemaRegistry: true },
          },
          outcome: {
            resolves:
              "No schema registered for subject 'smoke-value', and no schema provided to register.",
          },
          clientManager,
        });

        expect(clientManager.getSchemaRegistrySdkClient).toHaveBeenCalledWith(
          undefined,
        );
      });
    });
  });
});
