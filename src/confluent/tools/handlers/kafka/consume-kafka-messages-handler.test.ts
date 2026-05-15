import { KafkaJS } from "@confluentinc/kafka-javascript";
import {
  ConsumeKafkaMessagesHandler,
  consumeKafkaMessagesArgs,
} from "@src/confluent/tools/handlers/kafka/consume-kafka-messages-handler.js";
import {
  DEFAULT_CONNECTION_ID,
  runtimeWith,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  getMockedClientManager,
} from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

/**
 * Build a fake `admin.fetchTopicMetadata` result that mirrors what the
 * library actually returns at runtime (a bare `Array<ITopicMetadata>`).
 * The published `.d.ts` declares `Promise<{ topics: Array<ITopicMetadata> }>`
 * but the implementation hands back the array directly — see the matching
 * note in {@link consume-kafka-messages-handler.ts}. The cast hides the
 * declared-shape lie from the call site so tests stay readable.
 */
function fakeFetchTopicMetadataResult(
  topics: Array<{ name: string; numPartitions: number }>,
): Awaited<ReturnType<KafkaJS.Admin["fetchTopicMetadata"]>> {
  const arr = topics.map((t) => ({
    name: t.name,
    partitions: Array.from({ length: t.numPartitions }, (_, i) => ({
      partitionId: i,
      partitionErrorCode: 0,
      leader: 1,
      leaderNode: null,
      replicas: [1],
      replicaNodes: [],
      isr: [1],
      isrNodes: [],
    })),
  }));
  return arr as unknown as Awaited<
    ReturnType<KafkaJS.Admin["fetchTopicMetadata"]>
  >;
}

describe("consume-kafka-messages-handler.ts", () => {
  describe("consumeKafkaMessagesArgs (schema)", () => {
    it("should default offsetReset to 'latest' when omitted", () => {
      // The behavior change from #459: prior to this work, the handler
      // forced "earliest" via fromBeginning:true (OAuth) or
      // auto.offset.reset:"earliest" (direct). Natural-language asks
      // ("show me the latest X") expect "latest" by default.
      const parsed = consumeKafkaMessagesArgs.parse({
        topicNames: ["t"],
        value: {},
      });
      expect(parsed.offsetReset).toBe("latest");
    });

    it.each(["earliest", "latest", "none"] as const)(
      "should accept offsetReset='%s'",
      (offsetReset) => {
        const parsed = consumeKafkaMessagesArgs.parse({
          topicNames: ["t"],
          value: {},
          offsetReset,
        });
        expect(parsed.offsetReset).toBe(offsetReset);
      },
    );

    it("should reject an unknown offsetReset value with a Zod enum error citing the field", () => {
      const result = consumeKafkaMessagesArgs.safeParse({
        topicNames: ["t"],
        value: {},
        offsetReset: "from-the-middle",
      });
      expect(result.success).toBe(false);
      if (result.success) return;
      // Pin both the path and the error code so a future schema rename
      // (e.g. offsetReset → resetPolicy) doesn't pass with a generic
      // /validation failed/ regex match.
      expect(result.error.issues).toEqual([
        expect.objectContaining({
          path: ["offsetReset"],
          code: "invalid_value",
        }),
      ]);
    });
  });

  describe("consumeKafkaMessagesArgs (schema, topics[] xor topicNames)", () => {
    it("should accept just `topics`", () => {
      const parsed = consumeKafkaMessagesArgs.parse({
        topics: [{ topicName: "t" }],
        value: {},
      });
      expect(parsed.topics).toEqual([{ topicName: "t" }]);
      expect(parsed.topicNames).toBeUndefined();
    });

    it("should reject when both `topicNames` and `topics` are present", () => {
      const result = consumeKafkaMessagesArgs.safeParse({
        topicNames: ["t"],
        topics: [{ topicName: "t" }],
        value: {},
      });
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.issues).toEqual([
        expect.objectContaining({
          // The xor check is a top-level superRefine, so the issue path
          // is empty (the whole object is the problem, not one field).
          path: [],
          // "exactly one of" + "not both" together pin the both-present
          // branch and resist message rewording without losing
          // specificity. "either" lives in the both-absent branch only.
          message: expect.stringContaining("not both"),
        }),
      ]);
    });

    it("should reject when both `topicNames` and `topics` are absent", () => {
      const result = consumeKafkaMessagesArgs.safeParse({ value: {} });
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.issues).toEqual([
        expect.objectContaining({
          path: [],
          message: expect.stringContaining("either"),
        }),
      ]);
    });

    it("should reject an empty topicNames array", () => {
      const result = consumeKafkaMessagesArgs.safeParse({
        topicNames: [],
        value: {},
      });
      expect(result.success).toBe(false);
      if (result.success) return;
      // Either the inner nonempty-array check fires, or the xor superRefine
      // does (since an empty array is "absent" semantically). Pin the
      // observable behavior: at least one issue exists naming the empty
      // input.
      expect(result.error.issues.length).toBeGreaterThan(0);
    });

    it("should reject an empty topics array", () => {
      const result = consumeKafkaMessagesArgs.safeParse({
        topics: [],
        value: {},
      });
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.issues.length).toBeGreaterThan(0);
    });
  });

  describe("consumeKafkaMessagesArgs (schema, per-topic entry)", () => {
    it("should accept an entry with only `topicName`", () => {
      const parsed = consumeKafkaMessagesArgs.parse({
        topics: [{ topicName: "t" }],
        value: {},
      });
      expect(parsed.topics).toEqual([{ topicName: "t" }]);
    });

    it("should accept an entry with topicName + partition=0 (lowest valid partition index)", () => {
      const parsed = consumeKafkaMessagesArgs.parse({
        topics: [{ topicName: "t", partition: 0 }],
        value: {},
      });
      expect(parsed.topics?.[0]?.partition).toBe(0);
    });

    it("should reject a negative partition with a path naming the entry", () => {
      const result = consumeKafkaMessagesArgs.safeParse({
        topics: [{ topicName: "t", partition: -1 }],
        value: {},
      });
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.issues).toEqual([
        expect.objectContaining({
          path: ["topics", 0, "partition"],
        }),
      ]);
    });

    it("should reject a non-integer partition", () => {
      const result = consumeKafkaMessagesArgs.safeParse({
        topics: [{ topicName: "t", partition: 1.5 }],
        value: {},
      });
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.issues).toEqual([
        expect.objectContaining({
          path: ["topics", 0, "partition"],
        }),
      ]);
    });

    it("should accept a digit-only `offset` string", () => {
      const parsed = consumeKafkaMessagesArgs.parse({
        topics: [{ topicName: "t", offset: "12345" }],
        value: {},
      });
      expect(parsed.topics?.[0]?.offset).toBe("12345");
    });

    it("should accept an int64-shaped `offset` string beyond JS safe-integer range (2^53)", () => {
      // Kafka offsets are int64; the schema accepts strings precisely so
      // values past 2^53 don't lose precision via JS number coercion.
      const parsed = consumeKafkaMessagesArgs.parse({
        topics: [{ topicName: "t", offset: "9999999999999999999" }],
        value: {},
      });
      expect(parsed.topics?.[0]?.offset).toBe("9999999999999999999");
    });

    it("should reject a non-digit `offset` string", () => {
      const result = consumeKafkaMessagesArgs.safeParse({
        topics: [{ topicName: "t", offset: "ten" }],
        value: {},
      });
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.issues).toEqual([
        expect.objectContaining({
          path: ["topics", 0, "offset"],
        }),
      ]);
    });

    it("should reject an entry that supplies both `offset` and `timestamp`", () => {
      const result = consumeKafkaMessagesArgs.safeParse({
        topics: [
          { topicName: "t", offset: "10", timestamp: "2026-05-14T17:00:00Z" },
        ],
        value: {},
      });
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.issues).toEqual([
        expect.objectContaining({
          path: ["topics", 0],
          message: expect.stringMatching(/only one of .offset. or .timestamp./),
        }),
      ]);
    });

    it.each([
      "2026-05-14T17:00:00Z",
      "2026-05-14T13:00:00-04:00",
      "2026-05-14T20:00:00.500+00:00",
    ] as const)("should accept ISO 8601 timestamp '%s'", (timestamp) => {
      const parsed = consumeKafkaMessagesArgs.parse({
        topics: [{ topicName: "t", timestamp }],
        value: {},
      });
      expect(parsed.topics?.[0]?.timestamp).toBe(timestamp);
    });

    it("should accept a positive integer ms-since-epoch timestamp", () => {
      const parsed = consumeKafkaMessagesArgs.parse({
        topics: [{ topicName: "t", timestamp: 1747234567000 }],
        value: {},
      });
      expect(parsed.topics?.[0]?.timestamp).toBe(1747234567000);
    });

    it("should reject a malformed timestamp string", () => {
      const result = consumeKafkaMessagesArgs.safeParse({
        topics: [{ topicName: "t", timestamp: "not-a-date" }],
        value: {},
      });
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.issues).toEqual([
        expect.objectContaining({
          path: ["topics", 0, "timestamp"],
        }),
      ]);
    });

    it("should reject a non-positive timestamp number", () => {
      const result = consumeKafkaMessagesArgs.safeParse({
        topics: [{ topicName: "t", timestamp: -1 }],
        value: {},
      });
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.issues).toEqual([
        expect.objectContaining({
          path: ["topics", 0, "timestamp"],
        }),
      ]);
    });
  });

  describe("ConsumeKafkaMessagesHandler", () => {
    const handler = new ConsumeKafkaMessagesHandler();

    describe("handle()", () => {
      it("should pass the parsed offsetReset through to buildKafkaConsumer", async () => {
        // Pin the chunk-2 wiring: whatever Zod resolves for offsetReset
        // (default "latest" or an explicit value) is what the manager
        // sees. Consumer.run resolves immediately so we don't process
        // any messages; the assertion is the buildKafkaConsumer call.
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
            offsetReset: "earliest",
          },
          outcome: { resolves: "Consumed 0 messages from topics smoke" },
          clientManager,
        });

        expect(clientManager.buildKafkaConsumer).toHaveBeenCalledWith({
          clusterId: undefined,
          envId: undefined,
          groupId: undefined,
          offsetReset: "earliest",
        });
      });

      it("should propagate the default offsetReset ('latest') to buildKafkaConsumer when caller omits it", async () => {
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

        expect(clientManager.buildKafkaConsumer).toHaveBeenCalledWith({
          clusterId: undefined,
          envId: undefined,
          groupId: undefined,
          offsetReset: "latest",
        });
      });

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

      it("should reject `offset` without `partition` as a tool error citing the partition-scoped semantics", async () => {
        // Absolute offsets are partition-scoped: offset 10 on partition 0 is
        // a different message than offset 10 on partition 1. The handler
        // rejects ambiguity at pre-flight, before any broker call beyond
        // the admin probe (and in fact before that — the guard is the
        // first thing buildPreflightPlan does).
        const clientManager = getMockedClientManager();
        const consumer = await clientManager.getConsumer();
        consumer.disconnect.mockResolvedValue(undefined);

        await assertHandleCase({
          handler,
          runtime: runtimeWith(
            { kafka: { bootstrap_servers: "broker:9092" } },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            topics: [{ topicName: "smoke", offset: "10" }],
            maxMessages: 1,
            timeoutMs: 50,
            value: {},
          },
          outcome: {
            resolves: "Absolute offsets are partition-scoped",
          },
          clientManager,
        });
      });

      it("should reject a partition index >= numPartitions returned by fetchTopicMetadata", async () => {
        const clientManager = getMockedClientManager();
        const admin = await clientManager.getAdminClient();
        admin.fetchTopicMetadata.mockResolvedValue(
          fakeFetchTopicMetadataResult([{ name: "smoke", numPartitions: 2 }]),
        );

        await assertHandleCase({
          handler,
          runtime: runtimeWith(
            { kafka: { bootstrap_servers: "broker:9092" } },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            topics: [{ topicName: "smoke", partition: 7 }],
            maxMessages: 1,
            timeoutMs: 50,
            value: {},
          },
          outcome: {
            resolves: "requested partition 7 is out of range",
          },
          clientManager,
        });
      });

      it("should reject an `offset` below the partition's low watermark", async () => {
        const clientManager = getMockedClientManager();
        const admin = await clientManager.getAdminClient();
        admin.fetchTopicMetadata.mockResolvedValue(
          fakeFetchTopicMetadataResult([{ name: "smoke", numPartitions: 1 }]),
        );
        admin.fetchTopicOffsets.mockResolvedValue([
          { partition: 0, low: "100", high: "200", offset: "200" },
        ]);

        await assertHandleCase({
          handler,
          runtime: runtimeWith(
            { kafka: { bootstrap_servers: "broker:9092" } },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            topics: [{ topicName: "smoke", partition: 0, offset: "50" }],
            maxMessages: 1,
            timeoutMs: 50,
            value: {},
          },
          outcome: {
            resolves: "offset 50 is out of range [low=100, high=200)",
          },
          clientManager,
        });
      });

      it("should reject an `offset` >= the partition's high watermark", async () => {
        const clientManager = getMockedClientManager();
        const admin = await clientManager.getAdminClient();
        admin.fetchTopicMetadata.mockResolvedValue(
          fakeFetchTopicMetadataResult([{ name: "smoke", numPartitions: 1 }]),
        );
        admin.fetchTopicOffsets.mockResolvedValue([
          { partition: 0, low: "100", high: "200", offset: "200" },
        ]);

        await assertHandleCase({
          handler,
          runtime: runtimeWith(
            { kafka: { bootstrap_servers: "broker:9092" } },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            topics: [{ topicName: "smoke", partition: 0, offset: "200" }],
            maxMessages: 1,
            timeoutMs: 50,
            value: {},
          },
          outcome: {
            resolves: "offset 200 is out of range [low=100, high=200)",
          },
          clientManager,
        });
      });

      it("should reject a topic that mixes partition-specific entries with unrestricted entries", async () => {
        const clientManager = getMockedClientManager();
        const admin = await clientManager.getAdminClient();
        admin.fetchTopicMetadata.mockResolvedValue(
          fakeFetchTopicMetadataResult([{ name: "smoke", numPartitions: 2 }]),
        );

        await assertHandleCase({
          handler,
          runtime: runtimeWith(
            { kafka: { bootstrap_servers: "broker:9092" } },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            topics: [
              { topicName: "smoke", partition: 0 },
              { topicName: "smoke" },
            ],
            maxMessages: 1,
            timeoutMs: 50,
            value: {},
          },
          outcome: {
            resolves:
              'Topic "smoke" mixes entries with explicit partitions and entries without one',
          },
          clientManager,
        });
      });

      it("should pause unassigned-to-target partitions and seek to the explicit offset for the requested partition", async () => {
        // Happy path of the seek/pause dance: caller restricts to
        // partition 0 with an explicit offset. The broker assigns three
        // partitions (0, 1, 2); we expect pause on partitions 1 and 2,
        // and seek on partition 0 to the requested offset.
        const clientManager = getMockedClientManager();
        const admin = await clientManager.getAdminClient();
        admin.fetchTopicMetadata.mockResolvedValue(
          fakeFetchTopicMetadataResult([{ name: "smoke", numPartitions: 3 }]),
        );
        admin.fetchTopicOffsets.mockResolvedValue([
          { partition: 0, low: "0", high: "100", offset: "100" },
          { partition: 1, low: "0", high: "100", offset: "100" },
          { partition: 2, low: "0", high: "100", offset: "100" },
        ]);

        const consumer = await clientManager.getConsumer();
        consumer.connect.mockResolvedValue(undefined);
        consumer.subscribe.mockResolvedValue(undefined);
        consumer.run.mockResolvedValue(undefined);
        consumer.disconnect.mockResolvedValue(undefined);
        consumer.assignment.mockReturnValue([
          { topic: "smoke", partition: 0 },
          { topic: "smoke", partition: 1 },
          { topic: "smoke", partition: 2 },
        ]);

        await assertHandleCase({
          handler,
          runtime: runtimeWith(
            { kafka: { bootstrap_servers: "broker:9092" } },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            topics: [{ topicName: "smoke", partition: 0, offset: "42" }],
            maxMessages: 1,
            timeoutMs: 500,
            value: {},
          },
          outcome: { resolves: "Consumed 0 messages from topics smoke" },
          clientManager,
        });

        expect(consumer.pause).toHaveBeenCalledWith([
          { topic: "smoke", partitions: [1, 2] },
        ]);
        expect(consumer.seek).toHaveBeenCalledWith({
          topic: "smoke",
          partition: 0,
          offset: "42",
        });
      });

      it("should resolve a timestamp to per-partition offsets via fetchTopicOffsetsByTimestamp and seek each one", async () => {
        // With `timestamp` and no `partition`, the spec says: resolve
        // server-side to a per-partition offset map and seek each
        // partition independently. ISO 8601 inputs are normalized to ms
        // before the admin call.
        const clientManager = getMockedClientManager();
        const admin = await clientManager.getAdminClient();
        admin.fetchTopicMetadata.mockResolvedValue(
          fakeFetchTopicMetadataResult([{ name: "smoke", numPartitions: 2 }]),
        );
        admin.fetchTopicOffsetsByTimestamp.mockResolvedValue([
          { partition: 0, offset: "12" },
          { partition: 1, offset: "34" },
        ]);

        const consumer = await clientManager.getConsumer();
        consumer.connect.mockResolvedValue(undefined);
        consumer.subscribe.mockResolvedValue(undefined);
        consumer.run.mockResolvedValue(undefined);
        consumer.disconnect.mockResolvedValue(undefined);
        consumer.assignment.mockReturnValue([
          { topic: "smoke", partition: 0 },
          { topic: "smoke", partition: 1 },
        ]);

        // ISO 8601 string; the handler must convert to ms-since-epoch via
        // Date.parse before calling fetchTopicOffsetsByTimestamp.
        const isoTimestamp = "2026-05-14T17:00:00Z";
        const expectedMs = Date.parse(isoTimestamp);

        await assertHandleCase({
          handler,
          runtime: runtimeWith(
            { kafka: { bootstrap_servers: "broker:9092" } },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            topics: [{ topicName: "smoke", timestamp: isoTimestamp }],
            maxMessages: 1,
            timeoutMs: 500,
            value: {},
          },
          outcome: { resolves: "Consumed 0 messages from topics smoke" },
          clientManager,
        });

        expect(admin.fetchTopicOffsetsByTimestamp).toHaveBeenCalledWith(
          "smoke",
          expectedMs,
        );
        // No partition restriction → keepPartitions is empty for "smoke" →
        // no pause calls.
        expect(consumer.pause).not.toHaveBeenCalled();
        // Both partitions seek to their resolved offsets.
        expect(consumer.seek).toHaveBeenCalledWith({
          topic: "smoke",
          partition: 0,
          offset: "12",
        });
        expect(consumer.seek).toHaveBeenCalledWith({
          topic: "smoke",
          partition: 1,
          offset: "34",
        });
      });
    });
  });
});
