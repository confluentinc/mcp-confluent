import { KafkaJS } from "@confluentinc/kafka-javascript";
import type {
  EachMessagePayload,
  KafkaMessage,
} from "@confluentinc/kafka-javascript/types/kafkajs.js";
import {
  KEY_SCHEMA_ID_HEADER,
  SchemaId,
  SchemaRegistryClient,
  SerdeType,
  VALUE_SCHEMA_ID_HEADER,
} from "@confluentinc/schemaregistry";
import * as nodeDeps from "@src/confluent/node-deps.js";
import * as schemaRegistryHelper from "@src/confluent/schema-registry-helper.js";
import {
  applyPostAssignmentHook,
  consumeKafkaMessagesArgs,
  ConsumeKafkaMessagesHandler,
  createEachMessageHandler,
  formatMessageTimestamp,
  normalizeStart,
  waitForAssignment,
  type ProcessedMessage,
} from "@src/confluent/tools/handlers/kafka/consume-kafka-messages-handler.js";
import {
  DEFAULT_CONNECTION_ID,
  runtimeWith,
  runtimeWithDecoy,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  getMockedClientManager,
  getMockedConsumer,
} from "@tests/stubs/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

/**
 * Build a synthetic `RecordBatchEntry`-shaped `KafkaMessage` for tests.
 * The cast to `KafkaMessage` hides the fields the handler doesn't read
 * (`attributes`, `size`, `leaderEpoch`) so each test focuses on what's
 * load-bearing for the branch under test. Uses `in` checks so an
 * explicit `key: null` (a legitimate `KafkaMessage` shape) stays null
 * instead of falling through `??` to the default Buffer — the latter
 * would mask the null-key branch.
 */
function fakeMessage(
  overrides: {
    key?: Buffer | null;
    value?: Buffer | null;
    timestamp?: string;
    offset?: string;
    headers?: KafkaMessage["headers"];
  } = {},
): KafkaMessage {
  return {
    key: "key" in overrides ? overrides.key : Buffer.from("k"),
    value: "value" in overrides ? overrides.value : Buffer.from("v"),
    timestamp: overrides.timestamp ?? "1747234567000",
    offset: overrides.offset ?? "42",
    headers: overrides.headers,
  } as unknown as KafkaMessage;
}

describe("consume-kafka-messages-handler.ts", () => {
  describe("consumeKafkaMessagesArgs (schema, per-topic `start` default)", () => {
    it("should default each entry's `start` to 'earliest' when omitted", () => {
      // The default lives on the per-topic entry now (was on a
      // top-level `offsetReset` knob before #459). It defaults to
      // "earliest" to preserve the pre-#459 read-everything behavior
      // for bare-name calls: a caller asking for "the latest messages"
      // is expected to pass `start: "latest"` explicitly on the topic
      // entry that needs it.
      const parsed = consumeKafkaMessagesArgs.parse({
        topics: [{ name: "t" }],
        valueFormat: {},
      });
      expect(parsed.topics).toEqual([{ name: "t", start: "earliest" }]);
    });

    it.each(["earliest", "latest"] as const)(
      "should accept the literal `start: '%s'` direction value",
      (start) => {
        const parsed = consumeKafkaMessagesArgs.parse({
          topics: [{ name: "t", start }],
          valueFormat: {},
        });
        expect(parsed.topics).toEqual([{ name: "t", start }]);
      },
    );

    it("should reject an unknown `start` direction literal as a union miss on the `start` path", () => {
      // The path lands on the union field itself; a future rename of the
      // field (e.g. start → position) would shift the path and fail this
      // test rather than passing under a generic /validation failed/.
      const result = consumeKafkaMessagesArgs.safeParse({
        topics: [{ name: "t", start: "from-the-middle" }],
        valueFormat: {},
      });
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.issues).toEqual([
        expect.objectContaining({ path: ["topics", 0, "start"] }),
      ]);
    });
  });

  describe("consumeKafkaMessagesArgs (schema, topics[] presence + emptiness)", () => {
    it("should accept a `topics` array with one minimal entry", () => {
      const parsed = consumeKafkaMessagesArgs.parse({
        topics: [{ name: "t" }],
        valueFormat: {},
      });
      // The defaulted `start: "earliest"` lands on the parsed shape
      // even when the caller omits it on input — pin both fields here
      // so a future default flip is caught.
      expect(parsed.topics).toEqual([{ name: "t", start: "earliest" }]);
    });

    it("should reject when `topics` is absent", () => {
      const result = consumeKafkaMessagesArgs.safeParse({ valueFormat: {} });
      expect(result.success).toBe(false);
      if (result.success) return;
      // Required-field error from Zod cites the missing path.
      expect(result.error.issues).toEqual([
        expect.objectContaining({ path: ["topics"] }),
      ]);
    });

    it("should reject an empty `topics` array", () => {
      const result = consumeKafkaMessagesArgs.safeParse({
        topics: [],
        valueFormat: {},
      });
      expect(result.success).toBe(false);
      if (result.success) return;
      // The nonempty-array check fires on the `topics` path.
      expect(result.error.issues).toEqual([
        expect.objectContaining({ path: ["topics"] }),
      ]);
    });
  });

  describe("consumeKafkaMessagesArgs (schema, per-topic entry)", () => {
    it("should accept an entry with only `name`", () => {
      const parsed = consumeKafkaMessagesArgs.parse({
        topics: [{ name: "t" }],
        valueFormat: {},
      });
      // `start` is filled in by the schema default — the input entry is
      // bare-name but the parsed shape carries the defaulted direction.
      expect(parsed.topics).toEqual([{ name: "t", start: "earliest" }]);
    });

    it("should accept an entry with name + partition=0 (lowest valid partition index)", () => {
      const parsed = consumeKafkaMessagesArgs.parse({
        topics: [{ name: "t", partition: 0 }],
        valueFormat: {},
      });
      expect(parsed.topics[0]).toEqual({
        name: "t",
        partition: 0,
        start: "earliest",
      });
    });

    it("should reject a negative partition with a path naming the entry", () => {
      const result = consumeKafkaMessagesArgs.safeParse({
        topics: [{ name: "t", partition: -1 }],
        valueFormat: {},
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
        topics: [{ name: "t", partition: 1.5 }],
        valueFormat: {},
      });
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.issues).toEqual([
        expect.objectContaining({
          path: ["topics", 0, "partition"],
        }),
      ]);
    });

    it("should accept a digit-only `start: {offset}` string", () => {
      const parsed = consumeKafkaMessagesArgs.parse({
        topics: [{ name: "t", start: { offset: "12345" } }],
        valueFormat: {},
      });
      expect(parsed.topics[0]).toEqual({
        name: "t",
        start: { offset: "12345" },
      });
    });

    it("should accept an int64-shaped `start: {offset}` string beyond JS safe-integer range (2^53)", () => {
      // Kafka offsets are int64; the schema accepts strings precisely so
      // values past 2^53 don't lose precision via JS number coercion.
      const parsed = consumeKafkaMessagesArgs.parse({
        topics: [{ name: "t", start: { offset: "9999999999999999999" } }],
        valueFormat: {},
      });
      expect(parsed.topics[0]).toEqual({
        name: "t",
        start: { offset: "9999999999999999999" },
      });
    });

    it("should reject a non-digit `start: {offset}` string with the path drilling into `start.offset`", () => {
      // Zod 4 reports the granular inner path when only one union arm
      // matches structurally — here the `offset` arm wins on shape but
      // the regex inner-validation fails, so the path is
      // ["topics", 0, "start", "offset"] rather than a generic union
      // miss at ["topics", 0, "start"].
      const result = consumeKafkaMessagesArgs.safeParse({
        topics: [{ name: "t", start: { offset: "ten" } }],
        valueFormat: {},
      });
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.issues).toEqual([
        expect.objectContaining({
          path: ["topics", 0, "start", "offset"],
        }),
      ]);
    });

    it("should reject a `start` object that supplies both `offset` and `timestamp` (strictObject rejects the extra key)", () => {
      // Each object arm of the union is strict, so `{offset, timestamp}`
      // matches neither arm and falls through as a union miss. This is
      // the structural replacement for the old `offset` ⊻ `timestamp`
      // superRefine — Zod refuses the value rather than silently picking
      // an arm.
      const result = consumeKafkaMessagesArgs.safeParse({
        topics: [
          {
            name: "t",
            start: { offset: "10", timestamp: "2026-05-14T17:00:00Z" },
          },
        ],
        valueFormat: {},
      });
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.issues).toEqual([
        expect.objectContaining({ path: ["topics", 0, "start"] }),
      ]);
    });

    it.each([
      "2026-05-14T17:00:00Z",
      "2026-05-14T13:00:00-04:00",
      "2026-05-14T20:00:00.500+00:00",
    ] as const)(
      "should accept ISO 8601 `start: {timestamp: '%s'}`",
      (timestamp) => {
        const parsed = consumeKafkaMessagesArgs.parse({
          topics: [{ name: "t", start: { timestamp } }],
          valueFormat: {},
        });
        expect(parsed.topics[0]).toEqual({
          name: "t",
          start: { timestamp },
        });
      },
    );

    it("should accept a positive integer ms-since-epoch `start: {timestamp}`", () => {
      const parsed = consumeKafkaMessagesArgs.parse({
        topics: [{ name: "t", start: { timestamp: 1747234567000 } }],
        valueFormat: {},
      });
      expect(parsed.topics[0]).toEqual({
        name: "t",
        start: { timestamp: 1747234567000 },
      });
    });

    it("should accept `start: {timestamp: 0}` (Unix epoch) — symmetry with the ISO arm, which accepts '1970-01-01T00:00:00Z'", () => {
      // The numeric arm uses `.nonnegative()` so it stays in lockstep
      // with the ISO arm; rejecting 0 here while accepting the same
      // instant in ISO form would be a schema asymmetry.
      const parsed = consumeKafkaMessagesArgs.parse({
        topics: [{ name: "t", start: { timestamp: 0 } }],
        valueFormat: {},
      });
      expect(parsed.topics[0]).toEqual({
        name: "t",
        start: { timestamp: 0 },
      });
    });

    it("should reject a malformed `start: {timestamp}` string with the path drilling into `start.timestamp`", () => {
      // Same Zod-4 granular-path behavior as the offset case: the
      // timestamp arm matches structurally; the inner validation fails.
      const result = consumeKafkaMessagesArgs.safeParse({
        topics: [{ name: "t", start: { timestamp: "not-a-date" } }],
        valueFormat: {},
      });
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.issues).toEqual([
        expect.objectContaining({
          path: ["topics", 0, "start", "timestamp"],
        }),
      ]);
    });

    it("should reject a negative `start: {timestamp}` number with the path drilling into `start.timestamp`", () => {
      // The numeric arm uses `.nonnegative()` — negative values are
      // still rejected; only zero and positive integers pass.
      const result = consumeKafkaMessagesArgs.safeParse({
        topics: [{ name: "t", start: { timestamp: -1 } }],
        valueFormat: {},
      });
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.issues).toEqual([
        expect.objectContaining({
          path: ["topics", 0, "start", "timestamp"],
        }),
      ]);
    });

    it("should accept a positive integer `start: {tail}` count", () => {
      const parsed = consumeKafkaMessagesArgs.parse({
        topics: [{ name: "t", partition: 0, start: { tail: 5 } }],
        valueFormat: {},
      });
      expect(parsed.topics[0]).toEqual({
        name: "t",
        partition: 0,
        start: { tail: 5 },
      });
    });

    it.each([
      // [tailValue, why]
      [0, "rejects zero (positive() requires N > 0)"],
      [-3, "rejects negative N"],
    ] as const)(
      "should reject `start: {tail: %j}` with the path drilling into `start.tail` (%s)",
      (tail, _why) => {
        // Same Zod-4 granular-path behavior as offset's regex check: the
        // tail arm matches structurally; the inner value-range validation
        // (`.positive()`) fails inside it.
        const result = consumeKafkaMessagesArgs.safeParse({
          topics: [{ name: "t", partition: 0, start: { tail } }],
          valueFormat: {},
        });
        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.error.issues).toEqual([
          expect.objectContaining({
            path: ["topics", 0, "start", "tail"],
          }),
        ]);
      },
    );

    it("should reject a non-integer `start: {tail}` as a union miss at the `start` path (Zod 4's `.int()` participates in structural matching, unlike `.positive()`)", () => {
      // Empirical Zod 4 behavior: `.positive()` (value-range) drills to
      // `start.tail`; `.int()` (integer-ness) is treated as part of the
      // arm's structural shape, so a non-integer fails the union match
      // overall and the error sits at `start`. The path divergence is
      // pinned here so a future Zod upgrade that unifies the behavior
      // surfaces as a test diff rather than silent drift.
      const result = consumeKafkaMessagesArgs.safeParse({
        topics: [{ name: "t", partition: 0, start: { tail: 1.5 } }],
        valueFormat: {},
      });
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.issues).toEqual([
        expect.objectContaining({ path: ["topics", 0, "start"] }),
      ]);
    });

    it("should reject a `start` object combining `tail` with another arm's key (strictObject rejects the extra key)", () => {
      // Each object arm of the union is strict, so `{tail, offset}`
      // matches no arm structurally and falls through as a union miss
      // at the `start` path itself rather than at a nested key.
      const result = consumeKafkaMessagesArgs.safeParse({
        topics: [{ name: "t", partition: 0, start: { tail: 1, offset: "10" } }],
        valueFormat: {},
      });
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.issues).toEqual([
        expect.objectContaining({ path: ["topics", 0, "start"] }),
      ]);
    });
  });

  describe("ConsumeKafkaMessagesHandler", () => {
    const handler = new ConsumeKafkaMessagesHandler();

    describe("handle()", () => {
      // Fresh per-test client manager + consumer with the four no-op
      // lifecycle stubs every successful path needs. Tests that exercise
      // failure modes override the relevant method (e.g.
      // `consumer.run.mockRejectedValue(...)`); tests whose preflight
      // throws before the consumer is touched simply don't reference it.
      // Rebuilt in `beforeEach` rather than initialized once because
      // Vitest's `restoreMocks: true` only restores `vi.spyOn` originals,
      // not `vi.fn()` call histories or configured return values.
      let clientManager: ReturnType<typeof getMockedClientManager>;
      let consumer: ReturnType<typeof getMockedConsumer>;

      beforeEach(async () => {
        clientManager = getMockedClientManager();
        consumer = await clientManager.getConsumer();
        consumer.connect.mockResolvedValue(undefined);
        consumer.subscribe.mockResolvedValue(undefined);
        consumer.run.mockResolvedValue(undefined);
        consumer.disconnect.mockResolvedValue(undefined);
      });

      it("should pass derived offsetReset='earliest' to buildKafkaConsumer when every entry agrees on `start: 'earliest'`", async () => {
        // The consumer's `auto.offset.reset` is no longer a peer top-level
        // input; the handler derives it from the per-topic `start` values.
        // When every direction-only entry asks for 'earliest', that
        // becomes the consumer-wide reset and no explicit watermark seeks
        // are needed (the simple-call fast path is preserved).
        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            { kafka: { bootstrap_servers: "broker:9092" } },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            topics: [{ name: "smoke", start: "earliest" }],
            maxMessages: 1,
            timeoutMs: 50,
            valueFormat: {},
          },
          outcome: { resolves: "Consumed 0 messages from topics smoke" },
          clientManager,
        });

        expect(clientManager.buildKafkaConsumer).toHaveBeenCalledWith({
          clusterId: undefined,
          envId: undefined,
          // Per-invocation UUID — loose matcher per the unit-tests
          // rule's explicit allowance for generated UUIDs. A focused
          // test below pins the exact derivation contract.
          groupId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
          offsetReset: "earliest",
        });
      });

      it("should propagate the default offsetReset ('earliest') to buildKafkaConsumer when every entry omits `start`", async () => {
        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            { kafka: { bootstrap_servers: "broker:9092" } },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            topics: [{ name: "smoke" }],
            maxMessages: 1,
            timeoutMs: 50,
            valueFormat: {},
          },
          outcome: { resolves: "Consumed 0 messages from topics smoke" },
          clientManager,
        });

        expect(clientManager.buildKafkaConsumer).toHaveBeenCalledWith({
          clusterId: undefined,
          envId: undefined,
          // Per-invocation UUID — loose matcher per the unit-tests
          // rule's explicit allowance for generated UUIDs. A focused
          // test below pins the exact derivation contract.
          groupId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
          offsetReset: "earliest",
        });
      });

      it("should pass a fresh `nodeCrypto.randomUUID()` as groupId so each consume call is the sole member of its own Kafka consumer group (no concurrent-call partition contention)", async () => {
        // Pin the exact derivation: groupId is whatever
        // `nodeCrypto.randomUUID()` returned. Two concurrent calls
        // can't race for the same partition assignment because each
        // joins a different group of size 1.
        const stubbedUuid = "deadbeef-cafe-1234-5678-abcdef012345";
        vi.spyOn(nodeDeps.nodeCrypto, "randomUUID").mockReturnValue(
          stubbedUuid,
        );

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            { kafka: { bootstrap_servers: "broker:9092" } },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            topics: [{ name: "smoke" }],
            maxMessages: 1,
            timeoutMs: 50,
            valueFormat: {},
          },
          outcome: { resolves: "Consumed 0 messages from topics smoke" },
          clientManager,
        });

        expect(clientManager.buildKafkaConsumer).toHaveBeenCalledWith({
          clusterId: undefined,
          envId: undefined,
          groupId: stubbedUuid,
          offsetReset: "earliest",
        });
      });

      it("should return an isError response when consumer.run rejects", async () => {
        // The outer `catch (error)` in the consume handler catches errors
        // from connect/subscribe/run and renders them via formatKafkaError.
        // Mocking `consumer.run` to reject reaches this branch directly.
        consumer.run.mockRejectedValue(new Error("group rebalance failed"));

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            { kafka: { bootstrap_servers: "broker:9092" } },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            topics: [{ name: "smoke" }],
            maxMessages: 1,
            timeoutMs: 1000,
            valueFormat: {},
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

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            { kafka: { bootstrap_servers: "broker:9092" } },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            topics: [{ name: "smoke" }],
            maxMessages: 1,
            timeoutMs: 50,
            valueFormat: {},
          },
          outcome: { resolves: "Consumed 0 messages from topics smoke" },
          clientManager,
        });

        expect(consumer.subscribe).toHaveBeenCalledWith({
          topics: ["smoke"],
        });
        expect(consumer.disconnect).toHaveBeenCalledOnce();
      });

      it("should call getSchemaRegistrySdkClient with the resolved envId when SR is reachable on the connection", async () => {
        // Auto-decode default: with a `schema_registry` block on the
        // connection, the handler fetches the SR client even with no
        // explicit format args. Under direct-mode runtime,
        // `resolveKafkaClusterArgs` returns `envId: undefined`, so the
        // manager call is `(undefined)`. The assertion is on the call
        // shape, not message processing — the mocked `consumer.run`
        // resolves without invoking `eachMessage`.

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            {
              kafka: { bootstrap_servers: "broker:9092" },
              schema_registry: { endpoint: "https://sr.example" },
            },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            topics: [{ name: "smoke" }],
            maxMessages: 1,
            timeoutMs: 50,
          },
          outcome: { resolves: "Consumed 0 messages from topics smoke" },
          clientManager,
        });

        expect(clientManager.getSchemaRegistrySdkClient).toHaveBeenCalledWith(
          undefined,
        );
      });

      it("should skip the SR client fetch when both sides set disableSchemaRegistry: true even with SR reachable", async () => {
        // Even with `schema_registry` configured, an explicit opt-out on
        // BOTH sides short-circuits the SR fetch. A single-side opt-out
        // still triggers the fetch — covered by the auto-decode test
        // above (caller omits both, so neither side is disabled).

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            {
              kafka: { bootstrap_servers: "broker:9092" },
              schema_registry: { endpoint: "https://sr.example" },
            },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            topics: [{ name: "smoke" }],
            maxMessages: 1,
            timeoutMs: 50,
            valueFormat: { disableSchemaRegistry: true },
            keyFormat: { disableSchemaRegistry: true },
          },
          outcome: { resolves: "Consumed 0 messages from topics smoke" },
          clientManager,
        });

        expect(clientManager.getSchemaRegistrySdkClient).not.toHaveBeenCalled();
      });

      it("should skip the SR client fetch when the connection has no schema_registry block", async () => {
        // No SR reachable → no auto-fetch. This is the bare-kafka
        // connection path: the tool stays enabled (predicate is
        // kafkaBootstrapOrOAuth), just operates on raw bytes.

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            { kafka: { bootstrap_servers: "broker:9092" } },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            topics: [{ name: "smoke" }],
            maxMessages: 1,
            timeoutMs: 50,
          },
          outcome: { resolves: "Consumed 0 messages from topics smoke" },
          clientManager,
        });

        expect(clientManager.getSchemaRegistrySdkClient).not.toHaveBeenCalled();
      });

      it("should fall back to raw bytes (not error) when SR client fetch throws on the auto-decode path", async () => {
        // Graceful degradation: the caller didn't explicitly opt in to
        // SR, so a transport-level SR failure (auth, network, etc.)
        // shouldn't fail an otherwise-satisfiable consume. The handler
        // proceeds with `registry = undefined`, and per-message decoding
        // short-circuits to raw inside processMessage.
        clientManager.getSchemaRegistrySdkClient.mockRejectedValue(
          new Error("SR auth failed"),
        );

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            {
              kafka: { bootstrap_servers: "broker:9092" },
              schema_registry: { endpoint: "https://sr.example" },
            },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            topics: [{ name: "smoke" }],
            maxMessages: 1,
            timeoutMs: 50,
          },
          outcome: { resolves: "Consumed 0 messages from topics smoke" },
          clientManager,
        });
      });

      it("should reject `start: {offset}` without `partition` as a tool error citing the partition-scoped semantics", async () => {
        // Absolute offsets are partition-scoped: offset 10 on partition 0 is
        // a different message than offset 10 on partition 1. The handler
        // rejects ambiguity at pre-flight, before any broker call beyond
        // the admin probe (and in fact before that — the guard is the
        // first thing buildPreflightPlan does).
        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            { kafka: { bootstrap_servers: "broker:9092" } },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            topics: [{ name: "smoke", start: { offset: "10" } }],
            maxMessages: 1,
            timeoutMs: 50,
            valueFormat: {},
          },
          outcome: {
            resolves: "Absolute offsets are partition-scoped",
          },
          clientManager,
        });
      });

      it("should reject `start: {tail}` without `partition` as a tool error citing the partition-scoped semantics", async () => {
        // Tail is partition-scoped — "the last N messages" across all
        // partitions of a topic requires a freshness ordering decision
        // (broker timestamp vs producer timestamp vs payload field) that
        // the issue defers as out-of-scope. Reject loudly rather than
        // pick a default that surprises a caller.
        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            { kafka: { bootstrap_servers: "broker:9092" } },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            topics: [{ name: "smoke", start: { tail: 5 } }],
            maxMessages: 1,
            timeoutMs: 50,
            valueFormat: {},
          },
          outcome: {
            resolves: "Tail is partition-scoped",
          },
          clientManager,
        });
      });

      it("should reject a partition index >= numPartitions returned by fetchTopicMetadata", async () => {
        const admin = await clientManager.getAdminClient();
        admin.fetchTopicMetadata.mockResolvedValue(
          fakeFetchTopicMetadataResult([{ name: "smoke", numPartitions: 2 }]),
        );

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            { kafka: { bootstrap_servers: "broker:9092" } },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            topics: [{ name: "smoke", partition: 7 }],
            maxMessages: 1,
            timeoutMs: 50,
            valueFormat: {},
          },
          outcome: {
            resolves: "requested partition 7 is out of range",
          },
          clientManager,
        });
      });

      it("should reject an `offset` below the partition's low watermark", async () => {
        const admin = await clientManager.getAdminClient();
        admin.fetchTopicMetadata.mockResolvedValue(
          fakeFetchTopicMetadataResult([{ name: "smoke", numPartitions: 1 }]),
        );
        admin.fetchTopicOffsets.mockResolvedValue([
          { partition: 0, low: "100", high: "200", offset: "200" },
        ]);

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            { kafka: { bootstrap_servers: "broker:9092" } },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            topics: [{ name: "smoke", partition: 0, start: { offset: "50" } }],
            maxMessages: 1,
            timeoutMs: 50,
            valueFormat: {},
          },
          outcome: {
            resolves: "offset 50 is out of range [low=100, high=200)",
          },
          clientManager,
        });
      });

      it("should reject an `offset` >= the partition's high watermark", async () => {
        const admin = await clientManager.getAdminClient();
        admin.fetchTopicMetadata.mockResolvedValue(
          fakeFetchTopicMetadataResult([{ name: "smoke", numPartitions: 1 }]),
        );
        admin.fetchTopicOffsets.mockResolvedValue([
          { partition: 0, low: "100", high: "200", offset: "200" },
        ]);

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            { kafka: { bootstrap_servers: "broker:9092" } },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            topics: [{ name: "smoke", partition: 0, start: { offset: "200" } }],
            maxMessages: 1,
            timeoutMs: 50,
            valueFormat: {},
          },
          outcome: {
            resolves: "offset 200 is out of range [low=100, high=200)",
          },
          clientManager,
        });
      });

      it("should reject a topic that mixes partition-specific entries with unrestricted entries", async () => {
        const admin = await clientManager.getAdminClient();
        admin.fetchTopicMetadata.mockResolvedValue(
          fakeFetchTopicMetadataResult([{ name: "smoke", numPartitions: 2 }]),
        );

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            { kafka: { bootstrap_servers: "broker:9092" } },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            topics: [{ name: "smoke", partition: 0 }, { name: "smoke" }],
            maxMessages: 1,
            timeoutMs: 50,
            valueFormat: {},
          },
          outcome: {
            resolves:
              'Topic "smoke" mixes entries with explicit partitions and entries without one',
          },
          clientManager,
        });
      });

      it("should reject multiple unrestricted entries on the same topic (ambiguous: only one starting position per partition is honorable)", async () => {
        // Two entries for "smoke" both at the topic level, with
        // conflicting `start` directions. The schema/handler can't honor
        // both — exactly one start wins the race silently. Reject loudly
        // at preflight with a message naming the topic and the count.
        const admin = await clientManager.getAdminClient();
        admin.fetchTopicMetadata.mockResolvedValue(
          fakeFetchTopicMetadataResult([{ name: "smoke", numPartitions: 2 }]),
        );

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            { kafka: { bootstrap_servers: "broker:9092" } },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            topics: [
              { name: "smoke", start: "earliest" },
              { name: "smoke", start: "latest" },
            ],
            maxMessages: 1,
            timeoutMs: 50,
            valueFormat: {},
          },
          outcome: {
            resolves:
              'Topic "smoke" has 2 entries without partition restrictions',
          },
          clientManager,
        });
      });

      it("should reject duplicate `(topic, partition)` pairs (ambiguous: each subscribed partition has one starting position)", async () => {
        // Two entries for the same partition with different `start`
        // offsets — librdkafka would honor the seek that wins the
        // pre-run-stash race, silently dropping the other.
        const admin = await clientManager.getAdminClient();
        admin.fetchTopicMetadata.mockResolvedValue(
          fakeFetchTopicMetadataResult([{ name: "smoke", numPartitions: 2 }]),
        );

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            { kafka: { bootstrap_servers: "broker:9092" } },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            topics: [
              { name: "smoke", partition: 0, start: { offset: "10" } },
              { name: "smoke", partition: 0, start: { offset: "20" } },
            ],
            maxMessages: 1,
            timeoutMs: 50,
            valueFormat: {},
          },
          outcome: {
            resolves: 'Topic "smoke" has multiple entries for partition 0',
          },
          clientManager,
        });
      });

      it("should pause unassigned-to-target partitions and seek to the explicit offset for the requested partition", async () => {
        // Happy path of the seek/pause dance: caller restricts to
        // partition 0 with an explicit offset. The broker assigns three
        // partitions (0, 1, 2); we expect pause on partitions 1 and 2,
        // and seek on partition 0 to the requested offset.
        const admin = await clientManager.getAdminClient();
        admin.fetchTopicMetadata.mockResolvedValue(
          fakeFetchTopicMetadataResult([{ name: "smoke", numPartitions: 3 }]),
        );
        admin.fetchTopicOffsets.mockResolvedValue([
          { partition: 0, low: "0", high: "100", offset: "100" },
          { partition: 1, low: "0", high: "100", offset: "100" },
          { partition: 2, low: "0", high: "100", offset: "100" },
        ]);

        consumer.assignment.mockReturnValue([
          { topic: "smoke", partition: 0 },
          { topic: "smoke", partition: 1 },
          { topic: "smoke", partition: 2 },
        ]);

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            { kafka: { bootstrap_servers: "broker:9092" } },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            topics: [{ name: "smoke", partition: 0, start: { offset: "42" } }],
            maxMessages: 1,
            timeoutMs: 500,
            valueFormat: {},
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

      it("should seek to `high - N` for `start: {tail: N}` on a partition with enough retained messages", async () => {
        // Tail with low=10, high=20, N=1 → seek target = max(low, high-N)
        //   = max(10, 19) = 19. Consumer parks at offset 19 and the next
        // record delivered to eachMessage is the one whose offset == 19,
        // i.e. the last already-written record on the partition.
        const admin = await clientManager.getAdminClient();
        admin.fetchTopicMetadata.mockResolvedValue(
          fakeFetchTopicMetadataResult([{ name: "smoke", numPartitions: 1 }]),
        );
        admin.fetchTopicOffsets.mockResolvedValue([
          { partition: 0, low: "10", high: "20", offset: "20" },
        ]);

        consumer.assignment.mockReturnValue([{ topic: "smoke", partition: 0 }]);

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            { kafka: { bootstrap_servers: "broker:9092" } },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            topics: [{ name: "smoke", partition: 0, start: { tail: 1 } }],
            maxMessages: 1,
            timeoutMs: 50,
            valueFormat: {},
          },
          outcome: { resolves: "Consumed 0 messages from topics smoke" },
          clientManager,
        });

        expect(consumer.seek).toHaveBeenCalledWith({
          topic: "smoke",
          partition: 0,
          offset: "19",
        });
      });

      it("should clamp `start: {tail: N}` to the partition low watermark when N exceeds the retained-message count", async () => {
        // Tail with low=5, high=10, N=1000 → seek target = max(5, 10-1000)
        //   = max(5, -990) = 5. Asking for more messages than the partition
        // retains returns whatever's there, never an out-of-range error.
        const admin = await clientManager.getAdminClient();
        admin.fetchTopicMetadata.mockResolvedValue(
          fakeFetchTopicMetadataResult([{ name: "smoke", numPartitions: 1 }]),
        );
        admin.fetchTopicOffsets.mockResolvedValue([
          { partition: 0, low: "5", high: "10", offset: "10" },
        ]);

        consumer.assignment.mockReturnValue([{ topic: "smoke", partition: 0 }]);

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            { kafka: { bootstrap_servers: "broker:9092" } },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            topics: [{ name: "smoke", partition: 0, start: { tail: 1000 } }],
            maxMessages: 1,
            timeoutMs: 50,
            valueFormat: {},
          },
          outcome: { resolves: "Consumed 0 messages from topics smoke" },
          clientManager,
        });

        expect(consumer.seek).toHaveBeenCalledWith({
          topic: "smoke",
          partition: 0,
          offset: "5",
        });
      });

      it("should seek to the (equal) low/high watermark on an empty partition and return zero messages without error", async () => {
        // Empty partition: low === high === "0". Seek target collapses to
        // `high` (== `low`), the consumer parks at OFFSET_END, no records
        // flow, the timeoutMs budget elapses, and the orchestrator returns
        // an empty success response — exactly the issue's "tail: 1 on an
        // empty partition returns zero, no error" contract.
        const admin = await clientManager.getAdminClient();
        admin.fetchTopicMetadata.mockResolvedValue(
          fakeFetchTopicMetadataResult([{ name: "smoke", numPartitions: 1 }]),
        );
        admin.fetchTopicOffsets.mockResolvedValue([
          { partition: 0, low: "0", high: "0", offset: "0" },
        ]);

        consumer.assignment.mockReturnValue([{ topic: "smoke", partition: 0 }]);

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            { kafka: { bootstrap_servers: "broker:9092" } },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            topics: [{ name: "smoke", partition: 0, start: { tail: 1 } }],
            maxMessages: 1,
            timeoutMs: 50,
            valueFormat: {},
          },
          outcome: { resolves: "Consumed 0 messages from topics smoke" },
          clientManager,
        });

        expect(consumer.seek).toHaveBeenCalledWith({
          topic: "smoke",
          partition: 0,
          offset: "0",
        });
      });

      it("should resolve a timestamp to per-partition offsets via fetchTopicOffsetsByTimestamp and seek each one", async () => {
        // With `timestamp` and no `partition`, the spec says: resolve
        // server-side to a per-partition offset map and seek each
        // partition independently. ISO 8601 inputs are normalized to ms
        // before the admin call.
        const admin = await clientManager.getAdminClient();
        admin.fetchTopicMetadata.mockResolvedValue(
          fakeFetchTopicMetadataResult([{ name: "smoke", numPartitions: 2 }]),
        );
        admin.fetchTopicOffsetsByTimestamp.mockResolvedValue([
          { partition: 0, offset: "12" },
          { partition: 1, offset: "34" },
        ]);
        // The timestamp branch cross-checks watermarks to detect the
        // binding's silent high-watermark substitution. Both resolved
        // offsets are well below `high` here, so neither is filtered.
        admin.fetchTopicOffsets.mockResolvedValue([
          { partition: 0, low: "0", high: "100", offset: "100" },
          { partition: 1, low: "0", high: "100", offset: "100" },
        ]);

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
          runtime: runtimeWithDecoy(
            { kafka: { bootstrap_servers: "broker:9092" } },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            topics: [{ name: "smoke", start: { timestamp: isoTimestamp } }],
            maxMessages: 1,
            timeoutMs: 500,
            valueFormat: {},
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

      it("should skip the seek for a partition whose timestamp resolution equals the high watermark (silent-substitution case), and still seek the active partition", async () => {
        // `@confluentinc/kafka-javascript`'s fetchTopicOffsetsByTimestamp
        // silently substitutes the high watermark when a partition has no
        // message at or after the requested timestamp. The handler
        // cross-checks against fetchTopicOffsets and filters those partitions
        // out of the seek list (seeking to high == OFFSET_END would silently
        // park the consumer waiting for new messages with no diagnostic).
        const admin = await clientManager.getAdminClient();
        admin.fetchTopicMetadata.mockResolvedValue(
          fakeFetchTopicMetadataResult([{ name: "smoke", numPartitions: 2 }]),
        );
        // Partition 0: resolved offset 42 well below high 200 → active.
        // Partition 1: resolved offset 100 equal to high 100 → silent
        //              substitution fired, skip the seek.
        admin.fetchTopicOffsetsByTimestamp.mockResolvedValue([
          { partition: 0, offset: "42" },
          { partition: 1, offset: "100" },
        ]);
        admin.fetchTopicOffsets.mockResolvedValue([
          { partition: 0, low: "0", high: "200", offset: "200" },
          { partition: 1, low: "0", high: "100", offset: "100" },
        ]);

        consumer.assignment.mockReturnValue([
          { topic: "smoke", partition: 0 },
          { topic: "smoke", partition: 1 },
        ]);

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            { kafka: { bootstrap_servers: "broker:9092" } },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            topics: [
              { name: "smoke", start: { timestamp: "2026-05-14T17:00:00Z" } },
            ],
            maxMessages: 1,
            timeoutMs: 500,
            valueFormat: {},
          },
          outcome: { resolves: "Consumed 0 messages from topics smoke" },
          clientManager,
        });

        // Active partition seeks; silent partition does not.
        expect(consumer.seek).toHaveBeenCalledWith({
          topic: "smoke",
          partition: 0,
          offset: "42",
        });
        expect(consumer.seek).not.toHaveBeenCalledWith({
          topic: "smoke",
          partition: 1,
          offset: "100",
        });
        expect(consumer.seek).toHaveBeenCalledTimes(1);
      });

      it("should throw a tool-error response naming the timestamp when every partition's data ends before it (binding silent-substitution case)", async () => {
        // All partitions return offset == high watermark → all silent.
        // The handler must reject loudly rather than silently seeking
        // every partition to OFFSET_END (which would idle the consumer
        // until timeout and return 0 with no clue why).
        const admin = await clientManager.getAdminClient();
        admin.fetchTopicMetadata.mockResolvedValue(
          fakeFetchTopicMetadataResult([{ name: "smoke", numPartitions: 2 }]),
        );
        admin.fetchTopicOffsetsByTimestamp.mockResolvedValue([
          { partition: 0, offset: "200" },
          { partition: 1, offset: "100" },
        ]);
        admin.fetchTopicOffsets.mockResolvedValue([
          { partition: 0, low: "0", high: "200", offset: "200" },
          { partition: 1, low: "0", high: "100", offset: "100" },
        ]);

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            { kafka: { bootstrap_servers: "broker:9092" } },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            topics: [
              { name: "smoke", start: { timestamp: "2026-05-14T17:00:00Z" } },
            ],
            maxMessages: 1,
            timeoutMs: 50,
            valueFormat: {},
          },
          // Pin both the ISO timestamp (the literal user input echoed back)
          // and the "every partition" phrasing so future message rewording
          // doesn't pass a vacuous /failed/ match. The handler converts the
          // ISO input to ms then back to an ISO string for the message; the
          // round-trip lands on the same UTC instant.
          outcome: {
            resolves:
              'Topic "smoke" has no messages at or after timestamp 2026-05-14T17:00:00.000Z (every partition has no record produced past that point)',
          },
          clientManager,
        });
      });

      it("should name the restricted partition in the no-messages error when the caller targets a single partition that has no record at or after the timestamp", async () => {
        // Sibling of the prior test, but with `partition: 1` on the topic
        // entry so the filter narrows to one partition before the
        // silent-substitution check. Pins the "partition N has no record"
        // phrasing — the restricted-scope branch of the error message
        // that the every-partition test above doesn't cover.
        const admin = await clientManager.getAdminClient();
        admin.fetchTopicMetadata.mockResolvedValue(
          fakeFetchTopicMetadataResult([{ name: "smoke", numPartitions: 2 }]),
        );
        admin.fetchTopicOffsetsByTimestamp.mockResolvedValue([
          { partition: 0, offset: "50" },
          { partition: 1, offset: "100" },
        ]);
        admin.fetchTopicOffsets.mockResolvedValue([
          { partition: 0, low: "0", high: "200", offset: "200" },
          { partition: 1, low: "0", high: "100", offset: "100" },
        ]);

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            { kafka: { bootstrap_servers: "broker:9092" } },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            topics: [
              {
                name: "smoke",
                partition: 1,
                start: { timestamp: "2026-05-14T17:00:00Z" },
              },
            ],
            maxMessages: 1,
            timeoutMs: 50,
            valueFormat: {},
          },
          outcome: {
            resolves:
              'Topic "smoke" has no messages at or after timestamp 2026-05-14T17:00:00.000Z (partition 1 has no record produced past that point)',
          },
          clientManager,
        });
      });

      it("should pick offsetReset='latest' on mixed-direction calls and explicit-seek the 'earliest' minority to its partition low watermarks", async () => {
        // Two topics, opposite directions: A wants earliest, B wants
        // latest. The consumer can only have one auto.offset.reset, so
        // the handler picks "latest" — librdkafka's own default and the
        // option that keeps the explicit-seek work localized to the
        // "earliest" minority. The handler issues explicit low-watermark
        // seeks for A so it actually replays its history; B inherits the
        // consumer-wide "latest" and needs no explicit seek.
        const admin = await clientManager.getAdminClient();
        admin.fetchTopicMetadata.mockResolvedValue(
          fakeFetchTopicMetadataResult([
            { name: "topic-a", numPartitions: 2 },
            { name: "topic-b", numPartitions: 1 },
          ]),
        );
        // Only topic-a is fetched — topic-b's direction matches the
        // consumer default so the handler doesn't need its watermarks.
        admin.fetchTopicOffsets.mockResolvedValue([
          { partition: 0, low: "10", high: "100", offset: "100" },
          { partition: 1, low: "20", high: "100", offset: "100" },
        ]);

        consumer.assignment.mockReturnValue([
          { topic: "topic-a", partition: 0 },
          { topic: "topic-a", partition: 1 },
          { topic: "topic-b", partition: 0 },
        ]);

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            { kafka: { bootstrap_servers: "broker:9092" } },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            topics: [
              { name: "topic-a", start: "earliest" },
              { name: "topic-b", start: "latest" },
            ],
            maxMessages: 1,
            timeoutMs: 500,
            valueFormat: {},
          },
          outcome: {
            resolves: "Consumed 0 messages from topics topic-a, topic-b",
          },
          clientManager,
        });

        // Consumer-wide reset goes "latest" because not every
        // direction-only entry agrees on "earliest".
        expect(clientManager.buildKafkaConsumer).toHaveBeenCalledWith({
          clusterId: undefined,
          envId: undefined,
          // Per-invocation UUID — loose matcher per the unit-tests
          // rule's explicit allowance for generated UUIDs. A focused
          // test below pins the exact derivation contract.
          groupId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
          offsetReset: "latest",
        });
        // topic-a's partitions seek to their per-partition low watermarks
        // (10 and 20). topic-b stays at the consumer default.
        expect(consumer.seek).toHaveBeenCalledWith({
          topic: "topic-a",
          partition: 0,
          offset: "10",
        });
        expect(consumer.seek).toHaveBeenCalledWith({
          topic: "topic-a",
          partition: 1,
          offset: "20",
        });
        expect(consumer.seek).toHaveBeenCalledTimes(2);
      });

      it("should skip preflight entirely when every entry's `start` agrees on 'earliest' (no admin client call)", async () => {
        // Both entries direction-only and both pick "earliest" → the
        // consumer's auto.offset.reset is set to "earliest" and no per-
        // partition seek is needed. The handler should skip the admin
        // round-trip entirely — bare-direction-uniform is a fast path.
        const admin = await clientManager.getAdminClient();

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            { kafka: { bootstrap_servers: "broker:9092" } },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            topics: [
              { name: "topic-a", start: "earliest" },
              { name: "topic-b", start: "earliest" },
            ],
            maxMessages: 1,
            timeoutMs: 50,
            valueFormat: {},
          },
          outcome: {
            resolves: "Consumed 0 messages from topics topic-a, topic-b",
          },
          clientManager,
        });

        expect(clientManager.buildKafkaConsumer).toHaveBeenCalledWith({
          clusterId: undefined,
          envId: undefined,
          // Per-invocation UUID — loose matcher per the unit-tests
          // rule's explicit allowance for generated UUIDs. A focused
          // test below pins the exact derivation contract.
          groupId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
          offsetReset: "earliest",
        });
        // The fast path means no admin probing and no per-partition
        // seeks — only consumer.subscribe + the librdkafka-honored
        // consumer reset.
        expect(admin.fetchTopicMetadata).not.toHaveBeenCalled();
        expect(admin.fetchTopicOffsets).not.toHaveBeenCalled();
        expect(consumer.seek).not.toHaveBeenCalled();
        expect(consumer.pause).not.toHaveBeenCalled();
      });

      it("should resolve with 0 messages when applyPostAssignmentHook's waitForAssignment exhausts its deadline without an assignment (orchestrator's onAssignmentTimedOut callback)", async () => {
        // needsPreflight=true (because of `partition: 0`) so the
        // preflightHook arm of the race is active. consumer.assignment
        // always returns [] — waitForAssignment polls until its
        // deadlineMs catches up, then returns null and triggers the
        // orchestrator's `onAssignmentTimedOut` arrow (the body of
        // `accepting = false; timedOut.resolve()`).
        const admin = await clientManager.getAdminClient();
        admin.fetchTopicMetadata.mockResolvedValue(
          fakeFetchTopicMetadataResult([{ name: "smoke", numPartitions: 1 }]),
        );

        consumer.assignment.mockReturnValue([]);

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            { kafka: { bootstrap_servers: "broker:9092" } },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            topics: [{ name: "smoke", partition: 0 }],
            maxMessages: 1,
            timeoutMs: 100,
            valueFormat: {},
            keyFormat: {},
          },
          outcome: { resolves: "Consumed 0 messages from topics smoke" },
          clientManager,
        });

        // No assignment ever landed, so the post-assignment pause step
        // is never reached.
        expect(consumer.pause).not.toHaveBeenCalled();
      });

      it("should log via the disconnect-catch path when consumer.disconnect throws during cleanup", async () => {
        // Disconnect failures are caught inside the outer finally so
        // the surface response stays the success-shaped "Consumed N
        // messages..." text rather than getting replaced by a teardown
        // error. The orchestrator's only response is a logger.error;
        // the test verifies the response shape is preserved AND the
        // logger.error catch arm of the disconnect path was reached.
        consumer.disconnect.mockRejectedValue(new Error("disconnect kaboom"));

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            { kafka: { bootstrap_servers: "broker:9092" } },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            topics: [{ name: "smoke" }],
            maxMessages: 1,
            timeoutMs: 50,
            valueFormat: {},
            keyFormat: {},
          },
          // Disconnect failure during teardown does NOT corrupt the
          // success-shaped response — only the user-facing path is
          // pinned here, the log line itself is intentionally not
          // asserted (per the project's "do not test logging" rule).
          outcome: { resolves: "Consumed 0 messages from topics smoke" },
          clientManager,
        });

        expect(consumer.disconnect).toHaveBeenCalledOnce();
      });

      it("should resolve with exactly maxMessages records when consumer.run delivers more than that via the captured eachMessage (orchestrator's maxReached race arm)", async () => {
        // Capture the eachMessage callback from consumer.run and drive
        // it from the test. consumer.run's promise never resolves — the
        // race only finishes via maxReached.resolve() from onMaxReached.
        // Drives the post-refactor `Promise.race([maxReached.promise,
        // timedOut.promise, rejectOnly(runPromise), rejectOnly(preflightHook)])`
        // via its first arm.
        let captured:
          | ((payload: EachMessagePayload) => Promise<void>)
          | undefined;
        consumer.run.mockImplementation((opts) => {
          // `opts` infers as `ConsumerRunConfig | undefined` from the
          // mocked `consumer.run` signature; no `any` needed.
          captured = opts?.eachMessage;
          // Engine "still running" — never settles so it doesn't end
          // the race on its own.
          return new Promise<void>(() => {});
        });

        // Pre-parse so the args object satisfies the handler's
        // z.infer<>-typed `toolArguments` parameter (post-default
        // shape) — mirrors what the MCP framework hands the handler
        // in production, where the SDK has already validated and
        // defaulted the inputs.
        const handlePromise = handler.handle(
          // Direct handle() call (not assertHandleCase), so no decoy/auto-route
          // here — a single-connection runtime keeps this orchestrator-race test
          // focused on the maxReached arm.
          runtimeWith(
            { kafka: { bootstrap_servers: "broker:9092" } },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          consumeKafkaMessagesArgs.parse({
            topics: [{ name: "smoke" }],
            maxMessages: 2,
            timeoutMs: 5000,
            valueFormat: {},
            keyFormat: {},
          }),
        );

        // Yield so consumer.run's mockImplementation runs and `captured`
        // is set before we attempt to invoke it.
        await new Promise<void>((r) => setImmediate(r));
        expect(captured).toBeDefined();

        // Drive three deliveries; the third should be suppressed by the
        // orchestrator's `accepting = false` flip inside `onMaxReached`,
        // so consumedMessages caps at 2.
        await captured!({
          topic: "smoke",
          partition: 0,
          message: fakeMessage({ value: Buffer.from("v1") }),
        } as unknown as EachMessagePayload);
        await captured!({
          topic: "smoke",
          partition: 0,
          message: fakeMessage({ value: Buffer.from("v2") }),
        } as unknown as EachMessagePayload);
        await captured!({
          topic: "smoke",
          partition: 0,
          message: fakeMessage({ value: Buffer.from("v3") }),
        } as unknown as EachMessagePayload);

        const result = await handlePromise;
        const text = result.content
          .map((c) => ("text" in c ? c.text : ""))
          .join("");

        // Exactly two messages — proves the maxReached signal fired AND
        // the post-resolution `accepting` gate suppressed the third
        // delivery from being pushed.
        expect(text).toContain("Consumed 2 messages from topics smoke");
        // Disconnect runs from the outer finally even when the race
        // exits via the maxReached signal (not via an error).
        expect(consumer.disconnect).toHaveBeenCalledOnce();
      });
    });

    describe("processMessage()", () => {
      it("should return raw key/value strings + ISO-formatted timestamp when neither side uses schema registry", async () => {
        const result = await handler.processMessage(
          "topic-x",
          0,
          fakeMessage(),
          undefined,
          { disableSchemaRegistry: true },
          { disableSchemaRegistry: true },
        );
        // Literal-equal the whole shape so every field is pinned — drift
        // in any branch (key conversion, value conversion, timestamp
        // formatting, headers default, topic/partition passthrough) fails
        // here with a precise diff.
        expect(result).toEqual({
          key: "k",
          value: "v",
          timestamp: "2025-05-14T14:56:07.000Z",
          offset: "42",
          headers: undefined,
          topic: "topic-x",
          partition: 0,
        });
      });

      it("should leave the key undefined when the Kafka message has a null key", async () => {
        // `message.key` arrives as `null` (Buffer | null per the kafkajs
        // type), and the handler's `message.key?.toString()` initialization
        // plus the `if (message.key)` guard means the processed key stays
        // at its initial value of `undefined`.
        const result = await handler.processMessage(
          "topic-x",
          0,
          fakeMessage({ key: null }),
          undefined,
          { disableSchemaRegistry: true },
          { disableSchemaRegistry: true },
        );
        expect(result.key).toBeUndefined();
      });

      it("should convert defined headers to a record of stringified values (Buffer → string, undefined → empty string)", async () => {
        const result = await handler.processMessage(
          "topic-x",
          0,
          fakeMessage({
            headers: {
              "x-trace": Buffer.from("abc"),
              "x-empty": undefined,
            },
          }),
          undefined,
          { disableSchemaRegistry: true },
          { disableSchemaRegistry: true },
        );
        expect(result.headers).toEqual({
          "x-trace": "abc",
          "x-empty": "",
        });
      });

      it("should preserve a repeated-key header as a string array rather than comma-joining it", async () => {
        // Kafka headers are an ordered list where keys may repeat, so the
        // client surfaces a repeated key as an array. Stringifying the whole
        // array (Array.prototype.toString) would collapse ["x", "y"] to the
        // lossy "x,y" — indistinguishable from a single value containing a
        // comma. Map per element so multiplicity survives (#597).
        const result = await handler.processMessage(
          "topic-x",
          0,
          fakeMessage({ headers: { trace: ["x", "y"] } }),
          undefined,
          { disableSchemaRegistry: true },
          { disableSchemaRegistry: true },
        );
        expect(result.headers).toEqual({ trace: ["x", "y"] });
      });

      it("should stringify each Buffer element of a repeated-key header independently", async () => {
        const result = await handler.processMessage(
          "topic-x",
          0,
          fakeMessage({
            headers: { trace: [Buffer.from("x"), Buffer.from("y")] },
          }),
          undefined,
          { disableSchemaRegistry: true },
          { disableSchemaRegistry: true },
        );
        expect(result.headers).toEqual({ trace: ["x", "y"] });
      });

      it("should keep scalar headers scalar while preserving sibling array headers", async () => {
        const result = await handler.processMessage(
          "topic-x",
          0,
          fakeMessage({
            headers: { source: Buffer.from("clusterA"), trace: ["x", "y"] },
          }),
          undefined,
          { disableSchemaRegistry: true },
          { disableSchemaRegistry: true },
        );
        expect(result.headers).toEqual({
          source: "clusterA",
          trace: ["x", "y"],
        });
      });

      describe("schema-id header echo (always kept, decoded to GUID)", () => {
        // Per Stefan's #607 review: the __value_schema_id / __key_schema_id
        // headers identify the key/value schema by GUID, mirroring the CCloud
        // UI and the VS Code extension. Keep them on every echoed record and
        // surface the decoded GUID rather than the raw bytes — independent of
        // whether that side's payload decoded, bypassed decoding, or fell back
        // to raw.
        const fakeRegistry = {} as SchemaRegistryClient;
        const VALUE_GUID = "89e3a8f1-1111-2222-3333-444455556666";
        const KEY_GUID = "0f9d2c77-aaaa-bbbb-cccc-ddddeeeeffff";
        const headers = {
          [VALUE_SCHEMA_ID_HEADER]: new SchemaId(
            "AVRO",
            undefined,
            VALUE_GUID,
          ).guidToBytes(),
          [KEY_SCHEMA_ID_HEADER]: new SchemaId(
            "AVRO",
            undefined,
            KEY_GUID,
          ).guidToBytes(),
          "x-trace": Buffer.from("abc"),
        };
        const decodedHeaders = {
          [VALUE_SCHEMA_ID_HEADER]: VALUE_GUID,
          [KEY_SCHEMA_ID_HEADER]: KEY_GUID,
          "x-trace": "abc",
        };

        // Per-side decode result a case wants the spies to simulate. Only
        // consulted for a side that actually attempts decode (registry present
        // and disableSchemaRegistry false).
        type DecodeOutcome = "decode" | "no-schema" | "throw";

        it.each([
          {
            name: "both sides decode successfully",
            registry: () => fakeRegistry,
            valueFormat: { disableSchemaRegistry: false },
            keyFormat: { disableSchemaRegistry: false },
            valueOutcome: "decode" as DecodeOutcome,
            keyOutcome: "decode" as DecodeOutcome,
          },
          {
            name: "the value side bypasses decoding",
            registry: () => fakeRegistry,
            valueFormat: { disableSchemaRegistry: true },
            keyFormat: { disableSchemaRegistry: false },
            valueOutcome: "decode" as DecodeOutcome,
            keyOutcome: "decode" as DecodeOutcome,
          },
          {
            name: "the connection has no registry at all",
            registry: () => undefined,
            valueFormat: { disableSchemaRegistry: false },
            keyFormat: { disableSchemaRegistry: false },
            valueOutcome: "decode" as DecodeOutcome,
            keyOutcome: "decode" as DecodeOutcome,
          },
          {
            name: "the value side falls back to raw (no schema for the subject)",
            registry: () => fakeRegistry,
            valueFormat: { disableSchemaRegistry: false },
            keyFormat: { disableSchemaRegistry: false },
            valueOutcome: "no-schema" as DecodeOutcome,
            keyOutcome: "decode" as DecodeOutcome,
          },
          {
            name: "the value side falls back to raw (deserialization throws)",
            registry: () => fakeRegistry,
            valueFormat: { disableSchemaRegistry: false },
            keyFormat: { disableSchemaRegistry: false },
            valueOutcome: "throw" as DecodeOutcome,
            keyOutcome: "decode" as DecodeOutcome,
          },
        ])(
          "should keep both schema-id headers as decoded GUIDs when $name",
          async ({
            registry,
            valueFormat,
            keyFormat,
            valueOutcome,
            keyOutcome,
          }) => {
            const outcomeFor = (serdeType: SerdeType): DecodeOutcome =>
              serdeType === SerdeType.KEY ? keyOutcome : valueOutcome;

            vi.spyOn(
              schemaRegistryHelper,
              "getLatestSchemaIfExists",
            ).mockImplementation(async (_registry, subject) =>
              outcomeFor(
                subject.endsWith("-key") ? SerdeType.KEY : SerdeType.VALUE,
              ) === "no-schema"
                ? null
                : { schema: "{}", schemaType: "AVRO" },
            );
            vi.spyOn(
              schemaRegistryHelper,
              "deserializeMessage",
            ).mockImplementation(
              async (_topic, _buffer, _schemaType, _registry, serdeType) => {
                if (outcomeFor(serdeType) === "throw") {
                  throw new Error("boom");
                }
                return { decoded: serdeType };
              },
            );

            const result = await handler.processMessage(
              "topic-x",
              0,
              fakeMessage({ headers }),
              registry(),
              valueFormat,
              keyFormat,
            );
            expect(result.headers).toEqual(decodedHeaders);
          },
        );

        it("should fall back to the raw stringified value for a schema-id header that isn't a decodable GUID", async () => {
          // Defensive: a __value_schema_id carrying non-GUID bytes (here a
          // payload-format magic-byte-0 buffer) can't be decoded to a GUID, so
          // the echo falls back to the same stringification every other header
          // receives rather than emitting a bogus GUID.
          const rawBytes = Buffer.from([0, 0, 0, 0, 7]);
          const result = await handler.processMessage(
            "topic-x",
            0,
            fakeMessage({ headers: { [VALUE_SCHEMA_ID_HEADER]: rawBytes } }),
            undefined,
            { disableSchemaRegistry: true },
            { disableSchemaRegistry: true },
          );
          expect(result.headers).toEqual({
            [VALUE_SCHEMA_ID_HEADER]: rawBytes.toString(),
          });
        });
      });

      it("should pass message.timestamp through formatMessageTimestamp (integration with the '-1' sentinel)", async () => {
        // Cross-check that processMessage actually wires through
        // formatMessageTimestamp — the unit-test for that helper above
        // pins the four branches; this one pins the *integration*.
        const result = await handler.processMessage(
          "topic-x",
          0,
          fakeMessage({ timestamp: "-1" }),
          undefined,
          { disableSchemaRegistry: true },
          { disableSchemaRegistry: true },
        );
        expect(result.timestamp).toBe("(no timestamp)");
      });

      describe("with schema registry", () => {
        // The handler imports `getLatestSchemaIfExists` and
        // `deserializeMessage` via a namespace alias precisely so these
        // tests can spy on them via property lookup (ESM live bindings
        // refuse direct named-import interception). The fake registry is
        // an empty object cast — the spies short-circuit before the real
        // SDK is touched, so its surface doesn't matter.
        const fakeRegistry = {} as SchemaRegistryClient;

        it("should deserialize the value via schema registry when decoding is enabled and a schema exists", async () => {
          const getLatestSpy = vi
            .spyOn(schemaRegistryHelper, "getLatestSchemaIfExists")
            .mockResolvedValue({ schema: "{}", schemaType: "AVRO" });
          const deserializeSpy = vi
            .spyOn(schemaRegistryHelper, "deserializeMessage")
            .mockResolvedValue({ field: 42 });

          const result = await handler.processMessage(
            "topic-x",
            0,
            fakeMessage(),
            fakeRegistry,
            { disableSchemaRegistry: false },
            { disableSchemaRegistry: true },
          );

          // Value travels through the SR helpers; key stays raw.
          expect(result.value).toEqual({ field: 42 });
          expect(result.key).toBe("k");
          // Pin the default subject derivation: "<topic>-value" /
          // "<topic>-key" when options.subject is omitted.
          expect(getLatestSpy).toHaveBeenCalledWith(
            fakeRegistry,
            "topic-x-value",
          );
          expect(deserializeSpy).toHaveBeenCalledWith(
            "topic-x",
            Buffer.from("v"),
            "AVRO",
            fakeRegistry,
            SerdeType.VALUE,
            undefined,
            // deserializerCache: consume doesn't pass one (search does).
            undefined,
          );
        });

        it("should forward the raw record headers to deserializeMessage so a header-located schema id decodes", async () => {
          vi.spyOn(
            schemaRegistryHelper,
            "getLatestSchemaIfExists",
          ).mockResolvedValue({ schema: "{}", schemaType: "AVRO" });
          const deserializeSpy = vi
            .spyOn(schemaRegistryHelper, "deserializeMessage")
            .mockResolvedValue({ field: 7 });
          const headers = { [VALUE_SCHEMA_ID_HEADER]: Buffer.from([1, 2, 3]) };

          const result = await handler.processMessage(
            "topic-x",
            0,
            fakeMessage({ headers }),
            fakeRegistry,
            { disableSchemaRegistry: false },
            { disableSchemaRegistry: true },
          );

          expect(result.value).toEqual({ field: 7 });
          expect(deserializeSpy).toHaveBeenCalledWith(
            "topic-x",
            Buffer.from("v"),
            "AVRO",
            fakeRegistry,
            SerdeType.VALUE,
            headers,
            // deserializerCache: consume doesn't pass one (search does).
            undefined,
          );
        });

        it("should honor a caller-supplied subject instead of the default `${topic}-value`", async () => {
          const getLatestSpy = vi
            .spyOn(schemaRegistryHelper, "getLatestSchemaIfExists")
            .mockResolvedValue({ schema: "{}", schemaType: "AVRO" });
          vi.spyOn(
            schemaRegistryHelper,
            "deserializeMessage",
          ).mockResolvedValue("ok");

          await handler.processMessage(
            "topic-x",
            0,
            fakeMessage(),
            fakeRegistry,
            { disableSchemaRegistry: false, subject: "custom-subject-v1" },
            { disableSchemaRegistry: true },
          );

          expect(getLatestSpy).toHaveBeenCalledWith(
            fakeRegistry,
            "custom-subject-v1",
          );
        });

        it("should fall back to the raw string when getLatestSchemaIfExists returns null (no schema registered)", async () => {
          vi.spyOn(
            schemaRegistryHelper,
            "getLatestSchemaIfExists",
          ).mockResolvedValue(null);
          const deserializeSpy = vi.spyOn(
            schemaRegistryHelper,
            "deserializeMessage",
          );

          const result = await handler.processMessage(
            "topic-x",
            0,
            fakeMessage(),
            fakeRegistry,
            { disableSchemaRegistry: false },
            { disableSchemaRegistry: true },
          );

          expect(result.value).toBe("v");
          // No deserialization attempt at all — the null short-circuits
          // before the deserializer is consulted.
          expect(deserializeSpy).not.toHaveBeenCalled();
        });

        it("should fall back to the raw string when deserializeMessage throws (corrupt payload or schema mismatch)", async () => {
          vi.spyOn(
            schemaRegistryHelper,
            "getLatestSchemaIfExists",
          ).mockResolvedValue({ schema: "{}", schemaType: "AVRO" });
          vi.spyOn(
            schemaRegistryHelper,
            "deserializeMessage",
          ).mockRejectedValue(new Error("payload corrupt"));

          const result = await handler.processMessage(
            "topic-x",
            0,
            fakeMessage(),
            fakeRegistry,
            { disableSchemaRegistry: false },
            { disableSchemaRegistry: true },
          );

          // The catch arm logs and returns the raw string — the consumer
          // gets *something* rather than a propagated error that kills
          // the run.
          expect(result.value).toBe("v");
        });

        it("should deserialize the key with SerdeType.KEY when key-side decoding is enabled and the message has a key", async () => {
          const getLatestSpy = vi
            .spyOn(schemaRegistryHelper, "getLatestSchemaIfExists")
            .mockResolvedValue({ schema: "{}", schemaType: "AVRO" });
          const deserializeSpy = vi
            .spyOn(schemaRegistryHelper, "deserializeMessage")
            .mockResolvedValue("key-deserialized");

          const result = await handler.processMessage(
            "topic-x",
            0,
            fakeMessage(),
            fakeRegistry,
            { disableSchemaRegistry: true },
            { disableSchemaRegistry: false },
          );

          expect(result.key).toBe("key-deserialized");
          expect(result.value).toBe("v");
          // Default key subject is "<topic>-key" and SerdeType.KEY drives
          // the deserializer selection.
          expect(getLatestSpy).toHaveBeenCalledWith(
            fakeRegistry,
            "topic-x-key",
          );
          expect(deserializeSpy).toHaveBeenCalledWith(
            "topic-x",
            Buffer.from("k"),
            "AVRO",
            fakeRegistry,
            SerdeType.KEY,
            undefined,
            // deserializerCache: consume doesn't pass one (search does).
            undefined,
          );
        });

        it("should skip value deserialization entirely when message.value is null (a tombstone never triggers SR work)", async () => {
          const getLatestSpy = vi
            .spyOn(schemaRegistryHelper, "getLatestSchemaIfExists")
            .mockResolvedValue({ schema: "{}", schemaType: "AVRO" });
          const deserializeSpy = vi
            .spyOn(schemaRegistryHelper, "deserializeMessage")
            .mockResolvedValue({ decoded: true });

          const result = await handler.processMessage(
            "topic-x",
            0,
            fakeMessage({ value: null }),
            fakeRegistry,
            { disableSchemaRegistry: false },
            { disableSchemaRegistry: true },
          );

          expect(result.value).toBeUndefined();
          // A null payload (tombstone / absent value) short-circuits before any
          // SR lookup, so the deserializer is never handed a non-Buffer value
          // and no spurious error is logged on the inevitable failure.
          expect(getLatestSpy).not.toHaveBeenCalled();
          expect(deserializeSpy).not.toHaveBeenCalled();
        });

        it("should skip key deserialization entirely when message.key is null (the SR branch never fires for an absent key)", async () => {
          const getLatestSpy = vi.spyOn(
            schemaRegistryHelper,
            "getLatestSchemaIfExists",
          );
          const deserializeSpy = vi.spyOn(
            schemaRegistryHelper,
            "deserializeMessage",
          );

          const result = await handler.processMessage(
            "topic-x",
            0,
            fakeMessage({ key: null }),
            fakeRegistry,
            { disableSchemaRegistry: true },
            { disableSchemaRegistry: false },
          );

          expect(result.key).toBeUndefined();
          // The `if (message.key)` guard prevents any SR plumbing from
          // running on the key side.
          expect(getLatestSpy).not.toHaveBeenCalled();
          expect(deserializeSpy).not.toHaveBeenCalled();
        });
      });
    });
  });

  describe("formatMessageTimestamp()", () => {
    it.each([
      // [input, expected, why]
      [
        undefined,
        "(no timestamp)",
        "absent timestamps (pre-0.10.0 message format)",
      ],
      ["-1", "(no timestamp)", "Kafka sentinel for 'producer left it unset'"],
      [
        "1747234567000",
        "2025-05-14T14:56:07.000Z",
        "valid ms-since-epoch string → ISO 8601 UTC",
      ],
      [
        "banana",
        "banana",
        "non-numeric garbage → pass through verbatim (Number() returns NaN)",
      ],
      [
        "",
        "1970-01-01T00:00:00.000Z",
        "empty string → Number('') is 0 (finite) → epoch ISO (defensive edge case)",
      ],
    ] as const)("should map %j to %j (%s)", (input, expected, _why) => {
      expect(formatMessageTimestamp(input)).toBe(expected);
    });
  });

  describe("normalizeStart()", () => {
    // The literal-equal target is the same ISO instant in both timestamp
    // rows below; the difference is whether the input arrived as a string
    // (Date.parse path) or as a number (passthrough path). Pinning both
    // proves the two arms produce identical downstream targets — which
    // is precisely what callers need when they don't want to think about
    // which form the LLM picked.
    const sharedMs = 1747234567000;

    it.each([
      // [input, expected, why]
      ["earliest" as const, { kind: "earliest" }, "literal `earliest` arm"],
      ["latest" as const, { kind: "latest" }, "literal `latest` arm"],
      [
        { offset: "42" } as const,
        { kind: "offset", value: "42" },
        "object arm with absolute partition offset",
      ],
      [
        { timestamp: "2025-05-14T14:56:07.000Z" } as const,
        { kind: "timestamp", ms: sharedMs },
        "object arm with ISO 8601 string → Date.parse path",
      ],
      [
        { timestamp: sharedMs } as const,
        { kind: "timestamp", ms: sharedMs },
        "object arm with ms-since-epoch number → passthrough path",
      ],
      [
        { tail: 5 } as const,
        { kind: "tail", count: 5 },
        "object arm with last-N tail count",
      ],
    ])("should collapse %j to %j (%s)", (input, expected, _why) => {
      expect(normalizeStart(input)).toEqual(expected);
    });
  });

  describe("waitForAssignment()", () => {
    // Fake timers because the function's loop body awaits a 50ms
    // setTimeout between polls. Real wall-clock waits would make tests
    // either flaky or slow; fake timers let us pump iterations
    // deterministically. `restoreMocks: true` only restores vi.spyOn
    // installs, not fake-timer state, so the afterEach reverter is
    // load-bearing.
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("should return the assignment immediately when consumer.assignment() is already populated on the first poll", async () => {
      const populated = [{ topic: "x", partition: 0 }];
      const consumer = getMockedConsumer();
      consumer.assignment.mockReturnValue(populated);

      const result = await waitForAssignment(consumer, Date.now() + 5000);

      expect(result).toEqual(populated);
      // Single poll, no sleep entered.
      expect(consumer.assignment).toHaveBeenCalledOnce();
    });

    it("should return null when the deadline is already in the past and the assignment is still empty", async () => {
      const consumer = getMockedConsumer();
      consumer.assignment.mockReturnValue([]);

      // `Date.now() >= deadline` fires on the first iteration's
      // post-empty check, so the function returns null without entering
      // the setTimeout sleep.
      const result = await waitForAssignment(consumer, Date.now());

      expect(result).toBeNull();
      expect(consumer.assignment).toHaveBeenCalledOnce();
    });

    it("should poll, sleep, and return the assignment once a later iteration sees it populated", async () => {
      const populated = [{ topic: "x", partition: 0 }];
      const consumer = getMockedConsumer();
      consumer.assignment
        .mockReturnValueOnce([])
        .mockReturnValueOnce([])
        .mockReturnValue(populated);

      const pending = waitForAssignment(consumer, Date.now() + 5000);
      // Each iteration awaits a 50ms sleep. Advance fake time so the
      // first two sleeps resolve and the third poll runs against the
      // populated mock.
      await vi.advanceTimersByTimeAsync(50);
      await vi.advanceTimersByTimeAsync(50);

      expect(await pending).toEqual(populated);
      // Iter 1 empty → sleep, iter 2 empty → sleep, iter 3 populated →
      // return. Exactly three polls.
      expect(consumer.assignment).toHaveBeenCalledTimes(3);
    });

    it("should return null after polling past the deadline without the assignment populating", async () => {
      const consumer = getMockedConsumer();
      consumer.assignment.mockReturnValue([]);

      // deadline = now + 150ms; with 50ms sleeps the loop ticks at
      // t=0, 50, 100, 150 and the t=150 iteration's deadline check
      // (`>=`) fires.
      const pending = waitForAssignment(consumer, Date.now() + 150);
      await vi.advanceTimersByTimeAsync(200);

      expect(await pending).toBeNull();
      // At least three polls before the deadline trips on iter 4.
      expect(consumer.assignment.mock.calls.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("createEachMessageHandler()", () => {
    // Default processed-shape stand-in; tests that don't care about
    // contents reuse this so the assertions stay focused on
    // gating/signalling behavior.
    function makeProcessed(): ProcessedMessage {
      return {
        key: "k",
        value: "v",
        timestamp: "2025-05-14T14:56:07.000Z",
        offset: "42",
        headers: undefined,
        topic: "topic-x",
        partition: 0,
      };
    }

    function buildHandler(
      stateOverrides: {
        isAccepting?: () => boolean;
        isPreflightApplied?: () => boolean;
        shouldKeepDuringPrePause?: (
          topic: string,
          partition: number,
        ) => boolean;
        maxMessages?: number;
      } = {},
    ) {
      const consumedMessages: ProcessedMessage[] = [];
      const onMaxReached = vi.fn();
      const processMessage = vi.fn().mockResolvedValue(makeProcessed());
      const handler = createEachMessageHandler({
        state: {
          consumedMessages,
          isAccepting: stateOverrides.isAccepting ?? (() => true),
          isPreflightApplied: stateOverrides.isPreflightApplied ?? (() => true),
          shouldKeepDuringPrePause:
            stateOverrides.shouldKeepDuringPrePause ?? (() => true),
        },
        maxMessages: stateOverrides.maxMessages ?? 10,
        onMaxReached,
        processMessage,
      });
      return { handler, consumedMessages, onMaxReached, processMessage };
    }

    function payload(): EachMessagePayload {
      return {
        topic: "topic-x",
        partition: 0,
        message: fakeMessage(),
      } as unknown as EachMessagePayload;
    }

    it("should call processMessage with (topic, partition, message) and push the result to consumedMessages on the happy path", async () => {
      const { handler, processMessage, consumedMessages, onMaxReached } =
        buildHandler({ maxMessages: 10 });
      const inst = payload();

      await handler(inst);

      expect(processMessage).toHaveBeenCalledWith("topic-x", 0, inst.message);
      expect(consumedMessages).toEqual([makeProcessed()]);
      // Far below maxMessages → the signal must not fire.
      expect(onMaxReached).not.toHaveBeenCalled();
    });

    it("should drop the message without calling processMessage when isAccepting() returns false (post-resolution gate)", async () => {
      const { handler, processMessage, consumedMessages, onMaxReached } =
        buildHandler({ isAccepting: () => false });

      await handler(payload());

      expect(processMessage).not.toHaveBeenCalled();
      expect(consumedMessages).toHaveLength(0);
      expect(onMaxReached).not.toHaveBeenCalled();
    });

    it("should drop the message without calling processMessage when isPreflightApplied() is false AND the partition is outside the keep-set (pre-pause gate, partition-aware)", async () => {
      // Pre-pause: a delivery from a partition we intend to pause
      // arrives via librdkafka's fetch buffer between assignment-landing
      // and pause-being-applied. The gate must drop it; if it sneaked
      // through it'd corrupt consumedMessages with an off-target record.
      const { handler, processMessage, consumedMessages, onMaxReached } =
        buildHandler({
          isPreflightApplied: () => false,
          shouldKeepDuringPrePause: () => false,
        });

      await handler(payload());

      expect(processMessage).not.toHaveBeenCalled();
      expect(consumedMessages).toHaveLength(0);
      expect(onMaxReached).not.toHaveBeenCalled();
    });

    it("should let a keep-set partition through during the pre-pause window when isPreflightApplied() is still false (no silent data loss on the partitions the caller asked for)", async () => {
      // The bug Copilot caught: a partition-restricted consume can have
      // librdkafka deliver records for the keep-set partition as soon
      // as the rebalance assigns it (the pre-run-stashed seek is already
      // baked in), well before the post-assignment hook flips
      // preflightApplied. The earlier unconditional drop swallowed those
      // records silently. The partition-aware gate must let them through.
      const { handler, processMessage, consumedMessages } = buildHandler({
        isPreflightApplied: () => false,
        shouldKeepDuringPrePause: () => true,
      });

      const inst = payload();
      await handler(inst);

      expect(processMessage).toHaveBeenCalledWith("topic-x", 0, inst.message);
      expect(consumedMessages).toEqual([makeProcessed()]);
    });

    it("should consult shouldKeepDuringPrePause with the actual (topic, partition) of the delivery so the keep-set check is per-message, not per-call", async () => {
      // Pin the call shape: the gate must hand the real topic/partition
      // of each delivery to the predicate. A bug where the gate dropped
      // (or kept) every message regardless of partition would slip past
      // the tests above; this one calls the same handler twice with
      // different partitions and asserts both invocations land in the
      // predicate as their own observable call.
      const consumedMessages: ProcessedMessage[] = [];
      const onMaxReached = vi.fn();
      const processMessage = vi.fn().mockResolvedValue(makeProcessed());
      const shouldKeepDuringPrePause = vi
        .fn<(topic: string, partition: number) => boolean>()
        .mockImplementation((_topic, partition) => partition === 0);
      const handler = createEachMessageHandler({
        state: {
          consumedMessages,
          isAccepting: () => true,
          isPreflightApplied: () => false,
          shouldKeepDuringPrePause,
        },
        maxMessages: 10,
        onMaxReached,
        processMessage,
      });

      await handler({
        topic: "topic-x",
        partition: 0,
        message: fakeMessage(),
      } as unknown as EachMessagePayload);
      await handler({
        topic: "topic-x",
        partition: 1,
        message: fakeMessage(),
      } as unknown as EachMessagePayload);

      // The predicate was consulted twice with the matching args.
      expect(shouldKeepDuringPrePause).toHaveBeenCalledTimes(2);
      expect(shouldKeepDuringPrePause).toHaveBeenNthCalledWith(1, "topic-x", 0);
      expect(shouldKeepDuringPrePause).toHaveBeenNthCalledWith(2, "topic-x", 1);
      // Only the partition-0 message landed; partition-1 was dropped.
      expect(processMessage).toHaveBeenCalledOnce();
      expect(consumedMessages).toHaveLength(1);
    });

    it("should fire onMaxReached exactly once when the count reaches maxMessages", async () => {
      const { handler, consumedMessages, onMaxReached } = buildHandler({
        maxMessages: 2,
      });

      await handler(payload());
      expect(onMaxReached).not.toHaveBeenCalled();
      expect(consumedMessages).toHaveLength(1);

      await handler(payload());
      expect(onMaxReached).toHaveBeenCalledOnce();
      expect(consumedMessages).toHaveLength(2);
    });

    it("should keep firing onMaxReached on subsequent calls once the count is at-or-above maxMessages (the orchestrator's `accepting` gate is what stops the bleed; the factory itself stays branch-simple)", async () => {
      // Pin the actual contract: the factory always re-fires onMaxReached
      // once length >= maxMessages. Suppression of follow-up calls is
      // the orchestrator's job (via its accepting=false flip in the
      // onMaxReached handler). This test exists so a future "smart" gate
      // inside the factory fails loudly rather than silently changing
      // the orchestrator's responsibility.
      const { handler, consumedMessages, onMaxReached } = buildHandler({
        maxMessages: 1,
        // Stay accepting throughout so we exercise the inner branch.
        isAccepting: () => true,
      });

      await handler(payload());
      await handler(payload());
      await handler(payload());

      expect(consumedMessages).toHaveLength(3);
      expect(onMaxReached).toHaveBeenCalledTimes(3);
    });
  });

  describe("applyPostAssignmentHook()", () => {
    // Fake timers because the timeout branch drives waitForAssignment's
    // 50ms polling loop without burning wall-clock seconds.
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("should resolve onApplied (and not onAssignmentTimedOut) when the assignment populates and the pause step completes", async () => {
      const consumer = getMockedConsumer();
      // Assigned to partition 1; the plan asks us to keep only partition 0,
      // so applyPauseAfterAssignment should pause partition 1.
      consumer.assignment.mockReturnValue([{ topic: "topic-x", partition: 1 }]);
      consumer.pause.mockReturnValue(undefined);
      const onApplied = vi.fn();
      const onAssignmentTimedOut = vi.fn();

      await applyPostAssignmentHook({
        consumer,
        plan: {
          topicNames: ["topic-x"],
          keepPartitions: new Map([["topic-x", new Set([0])]]),
          seeks: [],
        },
        deadlineMs: Date.now() + 5000,
        onApplied,
        onAssignmentTimedOut,
      });

      expect(consumer.pause).toHaveBeenCalledWith([
        { topic: "topic-x", partitions: [1] },
      ]);
      expect(onApplied).toHaveBeenCalledOnce();
      expect(onAssignmentTimedOut).not.toHaveBeenCalled();
    });

    it("should fire onAssignmentTimedOut (and not onApplied or consumer.pause) when waitForAssignment exhausts the deadline without an assignment", async () => {
      const consumer = getMockedConsumer();
      consumer.assignment.mockReturnValue([]);
      const onApplied = vi.fn();
      const onAssignmentTimedOut = vi.fn();

      // Deadline already in the past — waitForAssignment returns null on
      // its first poll, so we never reach the pause step.
      await applyPostAssignmentHook({
        consumer,
        plan: {
          topicNames: ["topic-x"],
          keepPartitions: new Map([["topic-x", new Set([0])]]),
          seeks: [],
        },
        deadlineMs: Date.now(),
        onApplied,
        onAssignmentTimedOut,
      });

      expect(consumer.pause).not.toHaveBeenCalled();
      expect(onApplied).not.toHaveBeenCalled();
      expect(onAssignmentTimedOut).toHaveBeenCalledOnce();
    });

    it("should reject when consumer.pause throws during the post-assignment pause step", async () => {
      const consumer = getMockedConsumer();
      consumer.assignment.mockReturnValue([{ topic: "topic-x", partition: 1 }]);
      consumer.pause.mockImplementation(() => {
        throw new Error("pause kaboom");
      });
      const onApplied = vi.fn();
      const onAssignmentTimedOut = vi.fn();

      await expect(
        applyPostAssignmentHook({
          consumer,
          plan: {
            topicNames: ["topic-x"],
            // Keep only partition 0 → partition 1 must be paused → throws.
            keepPartitions: new Map([["topic-x", new Set([0])]]),
            seeks: [],
          },
          deadlineMs: Date.now() + 5000,
          onApplied,
          onAssignmentTimedOut,
        }),
      ).rejects.toThrow("pause kaboom");

      // Neither completion callback fires on failure — the rejection
      // is the only signal so the orchestrator's `rejectOnly` wrapper
      // can surface it as the race-losing error.
      expect(onApplied).not.toHaveBeenCalled();
      expect(onAssignmentTimedOut).not.toHaveBeenCalled();
    });
  });
});
