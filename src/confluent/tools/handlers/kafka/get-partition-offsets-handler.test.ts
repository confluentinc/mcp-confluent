import { KafkaJS } from "@confluentinc/kafka-javascript";
import { GetPartitionOffsetsHandler } from "@src/confluent/tools/handlers/kafka/get-partition-offsets-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { textOf } from "@tests/call-tool-result.js";
import {
  DEFAULT_CONNECTION_ID,
  kafkaRuntime,
  runtimeWithDecoy,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  getMockedClientManager,
} from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

describe("get-partition-offsets-handler.ts", () => {
  describe("getToolConfig()", () => {
    const handler = new GetPartitionOffsetsHandler();

    it("should expose the expected name, annotations, category, and input schema keys", () => {
      const config = handler.getToolConfig();
      expect(config.name).toBe(ToolName.GET_PARTITION_OFFSETS);
      expect(config.annotations.readOnlyHint).toBe(true);
      expect(Object.keys(config.inputSchema).sort()).toEqual([
        "cluster_id",
        "environment_id",
        "partition",
        "topicName",
      ]);
    });
  });

  describe("handle()", () => {
    const handler = new GetPartitionOffsetsHandler();

    it("should route only to its resolved connection in a multi-connection config", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchTopicOffsets.mockResolvedValue([
        { partition: 0, low: "0", high: "100", offset: "100" },
      ]);

      // runtimeWithDecoy gives a two-connection runtime (the DEFAULT_CONNECTION_ID
      // real connection + a decoy keyed DECOY_CONNECTION_ID). assertHandleCase
      // detects the decoy and injects `connectionId: DEFAULT_CONNECTION_ID` into
      // the provided args for handle(), then asserts the decoy's manager went
      // untouched — so `args` deliberately omits connectionId here.
      await assertHandleCase({
        handler,
        runtime: runtimeWithDecoy(
          { kafka: { bootstrap_servers: "broker:9092" } },
          DEFAULT_CONNECTION_ID,
          clientManager,
        ),
        args: { topicName: "orders" },
        outcome: { resolves: 'Partition offsets for "orders"' },
        clientManager,
      });
    });

    it("should return a structured payload with low/highWatermark as strings and computed messageCount for every partition", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchTopicOffsets.mockResolvedValue([
        { partition: 0, low: "0", high: "100", offset: "100" },
        { partition: 1, low: "50", high: "200", offset: "200" },
        { partition: 2, low: "0", high: "0", offset: "0" },
      ]);

      const result = await handler.handle(kafkaRuntime(clientManager), {
        topicName: "orders",
      });

      expect(admin.fetchTopicOffsets).toHaveBeenCalledOnce();
      expect(admin.fetchTopicOffsets).toHaveBeenCalledWith("orders");

      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual({
        topicName: "orders",
        partitions: [
          {
            partition: 0,
            lowWatermark: "0",
            highWatermark: "100",
            messageCount: 100,
          },
          {
            partition: 1,
            lowWatermark: "50",
            highWatermark: "200",
            messageCount: 150,
          },
          {
            partition: 2,
            lowWatermark: "0",
            highWatermark: "0",
            messageCount: 0,
          },
        ],
      });
      expect(textOf(result)).toContain(
        'Partition offsets for "orders" (3 partition(s))',
      );
    });

    it("should restrict the response to a single partition when the `partition` arg is supplied", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchTopicOffsets.mockResolvedValue([
        { partition: 0, low: "0", high: "100", offset: "100" },
        { partition: 1, low: "50", high: "200", offset: "200" },
        { partition: 2, low: "10", high: "20", offset: "20" },
      ]);

      const result = await handler.handle(kafkaRuntime(clientManager), {
        topicName: "orders",
        partition: 1,
      });

      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual({
        topicName: "orders",
        partitions: [
          {
            partition: 1,
            lowWatermark: "50",
            highWatermark: "200",
            messageCount: 150,
          },
        ],
      });
      expect(textOf(result)).toContain(
        'Partition offsets for "orders" (1 partition(s))',
      );
    });

    it("should return messageCount: 0 for an empty partition (low === high) without any special-case branch", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchTopicOffsets.mockResolvedValue([
        { partition: 0, low: "42", high: "42", offset: "42" },
      ]);

      const result = await handler.handle(kafkaRuntime(clientManager), {
        topicName: "empty-topic",
      });

      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual({
        topicName: "empty-topic",
        partitions: [
          {
            partition: 0,
            lowWatermark: "42",
            highWatermark: "42",
            messageCount: 0,
          },
        ],
      });
    });

    it("should preserve int64 precision when computing messageCount via BigInt subtraction (values past 2^53)", async () => {
      // JS Number arithmetic loses precision past Number.MAX_SAFE_INTEGER
      // (2^53 - 1). The handler must subtract via BigInt and then narrow,
      // so a three-message gap at the int64 boundary stays exactly 3.
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchTopicOffsets.mockResolvedValue([
        {
          partition: 0,
          low: "9007199254740990",
          high: "9007199254740993",
          offset: "9007199254740993",
        },
      ]);

      const result = await handler.handle(kafkaRuntime(clientManager), {
        topicName: "bigint-topic",
      });

      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual({
        topicName: "bigint-topic",
        partitions: [
          {
            partition: 0,
            lowWatermark: "9007199254740990",
            highWatermark: "9007199254740993",
            messageCount: 3,
          },
        ],
      });
    });

    it("should surface a clean 'topic not found' error when fetchTopicOffsets returns an empty array", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchTopicOffsets.mockResolvedValue([]);

      const result = await handler.handle(kafkaRuntime(clientManager), {
        topicName: "no-such-topic",
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(
        'Topic "no-such-topic" not found on this cluster',
      );
    });

    it("should surface a clean 'topic not found' error for a KafkaJSError carrying ERR_UNKNOWN_TOPIC_OR_PART (broker-issued unknown-topic code)", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchTopicOffsets.mockRejectedValue(
        new KafkaJS.KafkaJSError("Broker: Unknown topic or partition", {
          code: KafkaJS.ErrorCodes.ERR_UNKNOWN_TOPIC_OR_PART,
        }),
      );

      const result = await handler.handle(kafkaRuntime(clientManager), {
        topicName: "no-such-topic",
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(
        'Topic "no-such-topic" not found on this cluster',
      );
      // The friendly path replaces the librdkafka text entirely; the broker
      // wording must not leak through as the headline.
      expect(textOf(result)).not.toContain(
        "Broker: Unknown topic or partition",
      );
    });

    it("should surface a clean 'topic not found' error for a KafkaJSError carrying ERR__UNKNOWN_TOPIC (local librdkafka unknown-topic code)", async () => {
      // librdkafka emits two distinct codes for the same conceptual failure:
      // the broker-issued ERR_UNKNOWN_TOPIC_OR_PART (tested above) and the
      // local-side ERR__UNKNOWN_TOPIC (double underscore, fires when the
      // client's own metadata cache says the topic doesn't exist before a
      // round trip happens). Both must funnel into the same friendly path.
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchTopicOffsets.mockRejectedValue(
        new KafkaJS.KafkaJSError("Local: Unknown topic", {
          code: KafkaJS.ErrorCodes.ERR__UNKNOWN_TOPIC,
        }),
      );

      const result = await handler.handle(kafkaRuntime(clientManager), {
        topicName: "no-such-topic",
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(
        'Topic "no-such-topic" not found on this cluster',
      );
    });

    it("should surface the real Kafka error (NOT 'topic not found') when fetchTopicOffsets rejects with a connection/auth/timeout failure", async () => {
      // The whole point of this branch: an auth denial, a TLS handshake
      // failure, a broker timeout, or any other non-unknown-topic error
      // must NOT be misclassified as "topic not found" — that would hide
      // actionable troubleshooting detail from callers. Anything that
      // isn't one of the two unknown-topic codes flows through
      // formatKafkaError so the real cause reaches the agent.
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchTopicOffsets.mockRejectedValue(
        new KafkaJS.KafkaJSConnectionError("broker unreachable: ETIMEDOUT", {
          code: KafkaJS.ErrorCodes.ERR__TRANSPORT,
        }),
      );

      const result = await handler.handle(kafkaRuntime(clientManager), {
        topicName: "orders",
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("broker unreachable: ETIMEDOUT");
      expect(textOf(result)).not.toContain("not found on this cluster");
    });

    it("should surface the underlying message (NOT 'topic not found') when fetchTopicOffsets rejects with a non-Kafka error shape", async () => {
      // Defensive coverage of the "library threw something we don't
      // recognize" path: a plain Error has no `code` field, so it must
      // not satisfy the unknown-topic guard. formatKafkaError handles
      // arbitrary unknown shapes by stringifying them; the assertion
      // pins that the agent sees the real text, not the friendly one.
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchTopicOffsets.mockRejectedValue(
        new Error("unexpected library failure"),
      );

      const result = await handler.handle(kafkaRuntime(clientManager), {
        topicName: "orders",
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("unexpected library failure");
      expect(textOf(result)).not.toContain("not found on this cluster");
    });

    it("should surface a clean out-of-range error citing the actual partition span when a `partition` arg is past the topic's range", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchTopicOffsets.mockResolvedValue([
        { partition: 0, low: "0", high: "10", offset: "10" },
        { partition: 1, low: "0", high: "20", offset: "20" },
        { partition: 2, low: "0", high: "30", offset: "30" },
      ]);

      const result = await handler.handle(kafkaRuntime(clientManager), {
        topicName: "orders",
        partition: 5,
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(
        'Topic "orders" has 3 partition(s) (0..2); requested partition 5 is out of range',
      );
    });

    it("should reject a missing topicName at the Zod boundary", async () => {
      const clientManager = getMockedClientManager();
      await expect(
        handler.handle(kafkaRuntime(clientManager), {}),
      ).rejects.toThrowError(/topicName/);
    });

    it("should reject an empty topicName at the Zod boundary", async () => {
      const clientManager = getMockedClientManager();
      await expect(
        handler.handle(kafkaRuntime(clientManager), { topicName: "" }),
      ).rejects.toThrowError(/topicName/);
    });

    it("should reject a negative partition at the Zod boundary", async () => {
      const clientManager = getMockedClientManager();
      await expect(
        handler.handle(kafkaRuntime(clientManager), {
          topicName: "orders",
          partition: -1,
        }),
      ).rejects.toThrowError(/partition/);
    });
  });
});
