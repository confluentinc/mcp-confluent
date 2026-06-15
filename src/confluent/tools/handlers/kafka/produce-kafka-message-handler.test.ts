import { CREATE_UPDATE } from "@src/confluent/tools/base-tools.js";
import { ProduceKafkaMessageHandler } from "@src/confluent/tools/handlers/kafka/produce-kafka-message-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { textOf } from "@tests/call-tool-result.js";
import {
  DEFAULT_CONNECTION_ID,
  runtimeWith,
  runtimeWithDecoy,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  getMockedClientManager,
} from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

describe("produce-kafka-message-handler.ts", () => {
  describe("ProduceKafkaMessageHandler", () => {
    const handler = new ProduceKafkaMessageHandler();

    describe("getToolConfig()", () => {
      it("should expose the produce-message tool with CREATE_UPDATE annotations and the record-metadata args", () => {
        const config = handler.getToolConfig();
        expect(config.name).toBe(ToolName.PRODUCE_MESSAGE);
        expect(config.annotations).toBe(CREATE_UPDATE);
        expect(Object.keys(config.inputSchema)).toEqual(
          expect.arrayContaining(["partition", "timestamp", "headers"]),
        );
      });

      it("should attribute partition selection to the producer's partitioner, not the broker", () => {
        // partitioning is a producer-client decision; calling it the broker's
        // job misleads tool users about where the key-hash/partition selection happens
        const partition = handler.getToolConfig().inputSchema
          .partition as z.ZodType;
        expect(partition.description).toContain("producer's partitioner");
        expect(partition.description).not.toMatch(/broker/i);
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

      it("should serialize a numeric Avro value and send the buffer to the producer", async () => {
        const clientManager = getMockedClientManager();
        const producer = await clientManager.getProducer();
        producer.send.mockResolvedValue([
          { topicName: "smoke", partition: 0, offset: "5", errorCode: 0 },
        ]);
        // Latest registered value schema is a top-level Avro long, so the
        // numeric payload serializes against it rather than tripping the old
        // object-only guard.
        const registry = clientManager.getSchemaRegistryClient();
        registry.getAssociationsByResourceName.mockResolvedValue([]);
        registry.getLatestSchemaMetadata.mockResolvedValue({
          id: 1,
          version: 1,
          subject: "smoke-value",
          schema: '"long"',
          schemaType: "AVRO",
        });

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
              message: 123,
              useSchemaRegistry: true,
              schemaType: "AVRO",
            },
          },
          outcome: {
            resolves: "Message produced successfully to [Topic: smoke",
          },
          clientManager,
        });

        // Confluent wire format: magic byte 0x00, 4-byte big-endian schema id
        // (1), then the Avro long zigzag-varint encoding of 123 (0xF6 0x01).
        // No key entry, since the args carry only a value.
        expect(producer.send).toHaveBeenCalledWith({
          topic: "smoke",
          messages: [{ value: Buffer.from([0, 0, 0, 0, 1, 0xf6, 0x01]) }],
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

      describe("record metadata (partition, timestamp, headers)", () => {
        it.each([
          {
            name: "an explicit partition",
            extraArgs: { partition: 2 },
            expectedExtras: { partition: 2 },
          },
          {
            name: "an ISO 8601 timestamp normalized to ms-since-epoch",
            extraArgs: { timestamp: "2026-05-14T17:00:00Z" },
            expectedExtras: {
              timestamp: String(Date.parse("2026-05-14T17:00:00Z")),
            },
          },
          {
            // pins that the string arm accepts anything Date.parse handles, not
            // strictly ISO 8601 — the explicit GMT offset keeps it deterministic
            // across the runner's local timezone
            name: "a non-ISO Date.parse-able timestamp string",
            extraArgs: { timestamp: "14 May 2026 17:00:00 GMT" },
            expectedExtras: {
              timestamp: String(Date.parse("14 May 2026 17:00:00 GMT")),
            },
          },
          {
            name: "a ms-since-epoch timestamp passed through as a string",
            extraArgs: { timestamp: 1750000000000 },
            expectedExtras: { timestamp: "1750000000000" },
          },
          {
            name: "single- and multi-valued headers",
            extraArgs: { headers: { source: "clusterA", tags: ["x", "y"] } },
            expectedExtras: {
              headers: { source: "clusterA", tags: ["x", "y"] },
            },
          },
        ])(
          "should forward $name onto the producer message",
          async ({ extraArgs, expectedExtras }) => {
            const clientManager = getMockedClientManager();
            const producer = await clientManager.getProducer();
            producer.send.mockResolvedValue([
              { topicName: "smoke", partition: 0, offset: "5", errorCode: 0 },
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
                ...extraArgs,
              },
              outcome: {
                resolves: "Message produced successfully to [Topic: smoke",
              },
              clientManager,
            });

            expect(producer.send).toHaveBeenCalledWith({
              topic: "smoke",
              messages: [{ value: "hello", ...expectedExtras }],
            });
          },
        );

        it("should forward a serialized key and partition 0 alongside the value", async () => {
          const clientManager = getMockedClientManager();
          const producer = await clientManager.getProducer();
          producer.send.mockResolvedValue([
            { topicName: "smoke", partition: 0, offset: "5", errorCode: 0 },
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
              value: { message: "v", useSchemaRegistry: false },
              key: { message: "k", useSchemaRegistry: false },
              partition: 0,
            },
            outcome: {
              resolves: "Message produced successfully to [Topic: smoke",
            },
            clientManager,
          });

          expect(producer.send).toHaveBeenCalledWith({
            topic: "smoke",
            messages: [{ value: "v", key: "k", partition: 0 }],
          });
        });

        it("should return an error and skip the producer for an unparseable timestamp", async () => {
          // No-I/O input-validation early return, so call the handler directly
          // rather than through assertHandleCase (which requires a client getter
          // to have been touched).
          const clientManager = getMockedClientManager();
          const producer = await clientManager.getProducer();

          const result = await handler.handle(
            runtimeWith(
              { kafka: { bootstrap_servers: "broker:9092" } },
              DEFAULT_CONNECTION_ID,
              clientManager,
            ),
            {
              topicName: "smoke",
              value: { message: "hello", useSchemaRegistry: false },
              timestamp: "not-a-date",
            },
          );

          expect(result.isError).toBe(true);
          expect(textOf(result)).toContain(
            "Invalid timestamp 'not-a-date': expected a Date.parse-able date-time string (e.g. ISO 8601) or a non-negative integer ms-since-epoch number.",
          );
          expect(producer.send).not.toHaveBeenCalled();
        });

        it("should reject a fractional timestamp at the schema boundary", async () => {
          // ms-since-epoch must be a whole millisecond; a float would stringify
          // to e.g. "123.45", which Kafka's record timestamp can't represent.
          await expect(
            handler.handle(
              runtimeWith(
                { kafka: { bootstrap_servers: "broker:9092" } },
                DEFAULT_CONNECTION_ID,
              ),
              {
                topicName: "smoke",
                value: { message: "hi", useSchemaRegistry: false },
                timestamp: 123.45,
              },
            ),
          ).rejects.toMatchObject({
            issues: [
              {
                path: ["timestamp"],
                code: "invalid_union",
                errors: [
                  [expect.objectContaining({ expected: "string" })],
                  [expect.objectContaining({ expected: "int" })],
                ],
              },
            ],
          });
        });

        it("should reject a negative timestamp at the schema boundary", async () => {
          // ms-since-epoch is non-negative; -1 in particular is Kafka's
          // "no timestamp" sentinel (see consume-messages), so accepting it
          // would let a producer forge a phantom no-timestamp record.
          await expect(
            handler.handle(
              runtimeWith(
                { kafka: { bootstrap_servers: "broker:9092" } },
                DEFAULT_CONNECTION_ID,
              ),
              {
                topicName: "smoke",
                value: { message: "hi", useSchemaRegistry: false },
                timestamp: -1,
              },
            ),
          ).rejects.toMatchObject({
            issues: [{ path: ["timestamp"], code: "too_small" }],
          });
        });

        it("should reject a negative partition at the schema boundary", async () => {
          await expect(
            handler.handle(
              runtimeWith(
                { kafka: { bootstrap_servers: "broker:9092" } },
                DEFAULT_CONNECTION_ID,
              ),
              {
                topicName: "smoke",
                value: { message: "hi", useSchemaRegistry: false },
                partition: -1,
              },
            ),
          ).rejects.toMatchObject({
            issues: [{ path: ["partition"], code: "too_small" }],
          });
        });
      });
    });
  });
});
