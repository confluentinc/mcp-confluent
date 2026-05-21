import { KafkaJS } from "@confluentinc/kafka-javascript";
import type { LibrdKafkaError } from "@confluentinc/kafka-javascript/types/rdkafka.js";
import {
  getConsumerGroupLagArgs,
  GetConsumerGroupLagHandler,
  GetConsumerGroupLagResponse,
} from "@src/confluent/tools/handlers/kafka/get-consumer-group-lag-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { textOf } from "@tests/call-tool-result.js";
import { fakeLibrdKafkaError } from "@tests/factories/librdkafka.js";
import {
  bareRuntime,
  DEFAULT_CONNECTION_ID,
  kafkaRuntime,
} from "@tests/factories/runtime.js";
import { getMockedClientManager } from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

/** Curried convenience: most error paths in this file exercise the
 *  not-found mapping, so the local wrapper pins
 *  `ERR_GROUP_ID_NOT_FOUND` as the default code and a matching default
 *  message. Tests for other error scenarios call
 *  {@link fakeLibrdKafkaError} directly. */
function fakeNotFoundError(
  overrides: Partial<Parameters<typeof fakeLibrdKafkaError>[0]> = {},
) {
  return fakeLibrdKafkaError({
    message: "Broker: Group id not found",
    code: KafkaJS.ErrorCodes.ERR_GROUP_ID_NOT_FOUND,
    ...overrides,
  });
}

/** Per-partition row in `admin.fetchOffsets`'s response, with sensible
 *  defaults so tests only set the fields they care about. */
function fakeFetchedPartition(overrides: {
  partition: number;
  offset?: string;
  metadata?: string | null;
  leaderEpoch?: number | null;
  error?: LibrdKafkaError;
}) {
  return {
    offset: "100",
    metadata: null,
    leaderEpoch: null,
    ...overrides,
  };
}

/** Per-partition row in `admin.fetchTopicOffsets`'s response. The native
 *  binding also carries a committed `offset` field that the watermark
 *  helper drops — keeping it here so the fixture matches the upstream
 *  type. */
function fakeWatermark(overrides: {
  partition: number;
  low?: string;
  high?: string;
}) {
  const high = overrides.high ?? "100";
  return {
    low: "0",
    high,
    offset: high,
    ...overrides,
  };
}

describe("get-consumer-group-lag-handler.ts", () => {
  describe("getConsumerGroupLagArgs (schema)", () => {
    it("should accept the minimal valid input (groupId only)", () => {
      expect(() =>
        getConsumerGroupLagArgs.parse({ groupId: "my-group" }),
      ).not.toThrow();
    });

    it("should accept a groupId together with an optional topics filter", () => {
      expect(() =>
        getConsumerGroupLagArgs.parse({
          groupId: "my-group",
          topics: ["orders", "shipments"],
        }),
      ).not.toThrow();
    });

    it("should reject a missing groupId", () => {
      try {
        getConsumerGroupLagArgs.parse({});
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ZodError);
        const issues = (err as ZodError).issues;
        expect(issues).toHaveLength(1);
        expect(issues[0]!.path).toEqual(["groupId"]);
        expect(issues[0]!.code).toBe("invalid_type");
      }
    });

    it("should reject an empty groupId (min(1))", () => {
      try {
        getConsumerGroupLagArgs.parse({ groupId: "" });
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ZodError);
        const issues = (err as ZodError).issues;
        expect(issues).toHaveLength(1);
        expect(issues[0]!.path).toEqual(["groupId"]);
        expect(issues[0]!.code).toBe("too_small");
      }
    });

    it("should reject an empty topics array (the ambiguous filter)", () => {
      // An empty filter is ambiguous between "match nothing" and "match
      // everything"; the schema rejects it loudly rather than picking a
      // direction. Same posture as `list-consumer-groups`'
      // `matchStates: []` rejection.
      try {
        getConsumerGroupLagArgs.parse({ groupId: "g", topics: [] });
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ZodError);
        const issues = (err as ZodError).issues;
        expect(issues).toHaveLength(1);
        expect(issues[0]!.path).toEqual(["topics"]);
        expect(issues[0]!.code).toBe("too_small");
      }
    });

    it("should reject an empty topic name within the topics filter", () => {
      try {
        getConsumerGroupLagArgs.parse({ groupId: "g", topics: [""] });
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ZodError);
        const issues = (err as ZodError).issues;
        expect(issues).toHaveLength(1);
        expect(issues[0]!.path).toEqual(["topics", 0]);
        expect(issues[0]!.code).toBe("too_small");
      }
    });
  });

  describe("getToolConfig()", () => {
    const handler = new GetConsumerGroupLagHandler();

    it("should expose the expected name, annotations, and schema keys", () => {
      const config = handler.getToolConfig();
      expect(config.name).toBe(ToolName.GET_CONSUMER_GROUP_LAG);
      expect(config.annotations.readOnlyHint).toBe(true);
      expect(Object.keys(config.inputSchema).sort()).toEqual([
        "cluster_id",
        "environment_id",
        "groupId",
        "topics",
      ]);
    });
  });

  describe("enabledConnectionIds()", () => {
    const handler = new GetConsumerGroupLagHandler();

    it("should enable on a kafka runtime", () => {
      expect(handler.enabledConnectionIds(kafkaRuntime())).toEqual([
        DEFAULT_CONNECTION_ID,
      ]);
    });

    it("should disable on a bare runtime", () => {
      expect(handler.enabledConnectionIds(bareRuntime())).toEqual([]);
    });
  });

  describe("handle()", () => {
    const handler = new GetConsumerGroupLagHandler();

    it("should forward groupId verbatim to admin.fetchOffsets and not pass a topics field when the filter is omitted", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchOffsets.mockResolvedValue([]);

      await handler.handle(kafkaRuntime(clientManager), { groupId: "g1" });

      expect(admin.fetchOffsets).toHaveBeenCalledOnce();
      expect(admin.fetchOffsets).toHaveBeenCalledWith({ groupId: "g1" });
    });

    it("should forward groupId and a topics filter together when the filter is supplied", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchOffsets.mockResolvedValue([]);
      // The filter is forwarded so the broker can server-side-restrict; the
      // handler still resolves never-committed topics in the filter from the
      // watermark cache afterwards.
      admin.fetchTopicOffsets.mockResolvedValue([
        fakeWatermark({ partition: 0 }),
      ]);

      await handler.handle(kafkaRuntime(clientManager), {
        groupId: "g1",
        topics: ["orders", "shipments"],
      });

      expect(admin.fetchOffsets).toHaveBeenCalledOnce();
      expect(admin.fetchOffsets).toHaveBeenCalledWith({
        groupId: "g1",
        topics: ["orders", "shipments"],
      });
    });

    it("should compute per-partition lag for a single-topic group with multiple partitions (happy path)", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchOffsets.mockResolvedValue([
        {
          topic: "orders",
          partitions: [
            fakeFetchedPartition({ partition: 0, offset: "80" }),
            fakeFetchedPartition({ partition: 1, offset: "150" }),
          ],
        },
      ]);
      admin.fetchTopicOffsets.mockResolvedValue([
        fakeWatermark({ partition: 0, low: "0", high: "100" }),
        fakeWatermark({ partition: 1, low: "0", high: "200" }),
      ]);

      const result = await handler.handle(kafkaRuntime(clientManager), {
        groupId: "g1",
      });

      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual({
        groupId: "g1",
        topics: [
          {
            topic: "orders",
            partitions: [
              {
                partition: 0,
                committedOffset: "80",
                highWatermark: "100",
                lag: 20,
                metadata: null,
                leaderEpoch: null,
              },
              {
                partition: 1,
                committedOffset: "150",
                highWatermark: "200",
                lag: 50,
                metadata: null,
                leaderEpoch: null,
              },
            ],
          },
        ],
        totalLag: 70,
      } satisfies GetConsumerGroupLagResponse);
    });

    it("should sum lag across topics into totalLag for a multi-topic group", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchOffsets.mockResolvedValue([
        {
          topic: "orders",
          partitions: [fakeFetchedPartition({ partition: 0, offset: "10" })],
        },
        {
          topic: "shipments",
          partitions: [fakeFetchedPartition({ partition: 0, offset: "0" })],
        },
      ]);
      admin.fetchTopicOffsets.mockImplementation(async (topic: string) => {
        if (topic === "orders") {
          return [fakeWatermark({ partition: 0, low: "0", high: "30" })];
        }
        if (topic === "shipments") {
          return [fakeWatermark({ partition: 0, low: "0", high: "5" })];
        }
        throw new Error(`unexpected topic ${topic}`);
      });

      const result = await handler.handle(kafkaRuntime(clientManager), {
        groupId: "g1",
      });

      expect(result.isError).toBe(false);
      const payload = result.structuredContent as GetConsumerGroupLagResponse;
      expect(payload.totalLag).toBe(25);
      expect(payload.topics.map((t) => t.topic)).toEqual([
        "orders",
        "shipments",
      ]);
    });

    it("should surface a never-committed partition (offset === '-1') as committedOffset:null, lag:null and exclude it from totalLag", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchOffsets.mockResolvedValue([
        {
          topic: "orders",
          partitions: [
            fakeFetchedPartition({ partition: 0, offset: "50" }),
            fakeFetchedPartition({ partition: 1, offset: "-1" }),
          ],
        },
      ]);
      admin.fetchTopicOffsets.mockResolvedValue([
        fakeWatermark({ partition: 0, low: "0", high: "100" }),
        fakeWatermark({ partition: 1, low: "0", high: "999" }),
      ]);

      const result = await handler.handle(kafkaRuntime(clientManager), {
        groupId: "g1",
      });

      const payload = result.structuredContent as GetConsumerGroupLagResponse;
      expect(payload.topics[0]!.partitions[1]).toEqual({
        partition: 1,
        committedOffset: null,
        highWatermark: "999",
        lag: null,
        metadata: null,
        leaderEpoch: null,
      });
      // Only partition 0's lag (50) counts; partition 1's null lag is
      // excluded — without that exclusion we'd have synthesized a
      // misleading 999-message lag against the -1 sentinel.
      expect(payload.totalLag).toBe(50);
    });

    it("should surface a negative lag when committed > high (rebalance race) and include it in totalLag without crashing", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchOffsets.mockResolvedValue([
        {
          topic: "orders",
          partitions: [fakeFetchedPartition({ partition: 0, offset: "105" })],
        },
      ]);
      admin.fetchTopicOffsets.mockResolvedValue([
        fakeWatermark({ partition: 0, low: "0", high: "100" }),
      ]);

      const result = await handler.handle(kafkaRuntime(clientManager), {
        groupId: "g1",
      });

      const payload = result.structuredContent as GetConsumerGroupLagResponse;
      expect(payload.topics[0]!.partitions[0]!.lag).toBe(-5);
      // Negative lag IS included in totalLag — clamping to zero would
      // hide the rebalance-race state the diagnostic is there to expose.
      expect(payload.totalLag).toBe(-5);
    });

    it("should pass through metadata and leaderEpoch verbatim from admin.fetchOffsets", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchOffsets.mockResolvedValue([
        {
          topic: "orders",
          partitions: [
            fakeFetchedPartition({
              partition: 0,
              offset: "50",
              metadata: "checkpoint-A",
              leaderEpoch: 7,
            }),
          ],
        },
      ]);
      admin.fetchTopicOffsets.mockResolvedValue([
        fakeWatermark({ partition: 0, high: "100" }),
      ]);

      const result = await handler.handle(kafkaRuntime(clientManager), {
        groupId: "g1",
      });

      const partition = (
        result.structuredContent as GetConsumerGroupLagResponse
      ).topics[0]!.partitions[0]!;
      expect(partition.metadata).toBe("checkpoint-A");
      expect(partition.leaderEpoch).toBe(7);
    });

    it("should hit admin.fetchTopicOffsets exactly once per distinct topic across the response (memoized via the shared watermark cache)", async () => {
      // The issue spec is explicit: a multi-partition single-topic group
      // should make ONE watermark round-trip, not one per partition. The
      // cache from `partition-watermarks.ts` is the load-bearing seam;
      // this test pins the reuse.
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchOffsets.mockResolvedValue([
        {
          topic: "orders",
          partitions: [
            fakeFetchedPartition({ partition: 0, offset: "10" }),
            fakeFetchedPartition({ partition: 1, offset: "20" }),
            fakeFetchedPartition({ partition: 2, offset: "30" }),
          ],
        },
      ]);
      admin.fetchTopicOffsets.mockResolvedValue([
        fakeWatermark({ partition: 0, high: "100" }),
        fakeWatermark({ partition: 1, high: "100" }),
        fakeWatermark({ partition: 2, high: "100" }),
      ]);

      await handler.handle(kafkaRuntime(clientManager), { groupId: "g1" });

      expect(admin.fetchTopicOffsets).toHaveBeenCalledOnce();
      expect(admin.fetchTopicOffsets).toHaveBeenCalledWith("orders");
    });

    it("should map an ERR_GROUP_ID_NOT_FOUND rejection from admin.fetchOffsets to a friendly tool-level not-found error keyed on the requested groupId", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchOffsets.mockRejectedValue(fakeNotFoundError());

      const result = await handler.handle(kafkaRuntime(clientManager), {
        groupId: "ghost-group",
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(
        'Consumer group "ghost-group" not found on this cluster.',
      );
    });

    it("should let a non-not-found rejection from admin.fetchOffsets propagate without try/catch swallow", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchOffsets.mockRejectedValue(
        fakeLibrdKafkaError({
          code: KafkaJS.ErrorCodes.ERR_GROUP_AUTHORIZATION_FAILED,
          message: "Broker: Group authorization failed",
        }),
      );

      await expect(
        handler.handle(kafkaRuntime(clientManager), { groupId: "g1" }),
      ).rejects.toMatchObject({
        code: KafkaJS.ErrorCodes.ERR_GROUP_AUTHORIZATION_FAILED,
      });
    });

    it("should return zero topics and totalLag:0 when admin.fetchOffsets resolves with an empty array (group has never committed)", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchOffsets.mockResolvedValue([]);

      const result = await handler.handle(kafkaRuntime(clientManager), {
        groupId: "g1",
      });

      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual({
        groupId: "g1",
        topics: [],
        totalLag: 0,
      } satisfies GetConsumerGroupLagResponse);
      // The watermark cache should not have been hit — no topics in the
      // response means no per-topic watermark round-trips.
      expect(admin.fetchTopicOffsets).not.toHaveBeenCalled();
    });

    it("should include a never-committed topic (in the filter but not in fetchOffsets output) as {topic, partitions: []} when its watermark fetch succeeds", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      // Group has committed to `orders` only; caller asks about
      // `orders` + `shipments` (which exists but the group hasn't
      // touched). `shipments` should appear in the response with an
      // empty partitions array, NOT be silently dropped.
      admin.fetchOffsets.mockResolvedValue([
        {
          topic: "orders",
          partitions: [fakeFetchedPartition({ partition: 0, offset: "10" })],
        },
      ]);
      admin.fetchTopicOffsets.mockImplementation(async (topic: string) => {
        if (topic === "orders") {
          return [fakeWatermark({ partition: 0, high: "30" })];
        }
        if (topic === "shipments") {
          return [fakeWatermark({ partition: 0, high: "999" })];
        }
        throw new Error(`unexpected topic ${topic}`);
      });

      const result = await handler.handle(kafkaRuntime(clientManager), {
        groupId: "g1",
        topics: ["orders", "shipments"],
      });

      const payload = result.structuredContent as GetConsumerGroupLagResponse;
      const shipments = payload.topics.find((t) => t.topic === "shipments");
      expect(shipments).toEqual({ topic: "shipments", partitions: [] });
      // The orders topic still has its lag computed.
      expect(payload.totalLag).toBe(20);
    });

    it("should surface a friendly 'Topic <name> not found' error when a filtered topic does not exist on the cluster", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchOffsets.mockResolvedValue([]);
      // Watermark fetch rejects with the librdkafka unknown-topic code
      // for the filtered topic — same posture get-partition-offsets
      // takes for its own "topic not found" mapping.
      const unknownTopicErr = new KafkaJS.KafkaJSError(
        "Broker: Unknown topic or partition",
        { code: KafkaJS.ErrorCodes.ERR_UNKNOWN_TOPIC_OR_PART },
      );
      admin.fetchTopicOffsets.mockRejectedValue(unknownTopicErr);

      const result = await handler.handle(kafkaRuntime(clientManager), {
        groupId: "g1",
        topics: ["does-not-exist"],
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(
        'Topic "does-not-exist" not found on this cluster.',
      );
    });

    it("should surface the same 'Topic <name> not found' error when the watermark fetch rejects with the local-side ERR__UNKNOWN_TOPIC code", async () => {
      // ERR_UNKNOWN_TOPIC_OR_PART is broker-issued (single underscore);
      // ERR__UNKNOWN_TOPIC is client-local (double underscore — fires
      // when librdkafka's own metadata cache rejects the topic before
      // the broker is consulted). Both map to the same friendly error.
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchOffsets.mockResolvedValue([]);
      const unknownTopicErr = new KafkaJS.KafkaJSError("Local: Unknown topic", {
        code: KafkaJS.ErrorCodes.ERR__UNKNOWN_TOPIC,
      });
      admin.fetchTopicOffsets.mockRejectedValue(unknownTopicErr);

      const result = await handler.handle(kafkaRuntime(clientManager), {
        groupId: "g1",
        topics: ["mystery-topic"],
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(
        'Topic "mystery-topic" not found on this cluster.',
      );
    });

    it("should include a single-sentence human text summary citing the groupId, totalLag, and topic count", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchOffsets.mockResolvedValue([
        {
          topic: "orders",
          partitions: [fakeFetchedPartition({ partition: 0, offset: "10" })],
        },
        {
          topic: "shipments",
          partitions: [fakeFetchedPartition({ partition: 0, offset: "0" })],
        },
      ]);
      admin.fetchTopicOffsets.mockImplementation(async (topic: string) => {
        if (topic === "orders") {
          return [fakeWatermark({ partition: 0, high: "30" })];
        }
        return [fakeWatermark({ partition: 0, high: "5" })];
      });

      const result = await handler.handle(kafkaRuntime(clientManager), {
        groupId: "g1",
      });

      expect(textOf(result)).toContain(
        'Consumer group "g1" has 25 message(s) of lag across 2 topic(s).',
      );
    });
  });
});
