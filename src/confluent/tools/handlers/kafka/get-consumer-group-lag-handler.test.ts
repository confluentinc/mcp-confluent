import { KafkaJS } from "@confluentinc/kafka-javascript";
import type { FetchOffsetsPartition } from "@confluentinc/kafka-javascript/types/kafkajs.js";
import type {
  GroupDescription,
  LibrdKafkaError,
} from "@confluentinc/kafka-javascript/types/rdkafka.js";
import {
  getConsumerGroupLagArgs,
  GetConsumerGroupLagHandler,
  GetConsumerGroupLagResponse,
} from "@src/confluent/tools/handlers/kafka/get-consumer-group-lag-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { logger } from "@src/logger.js";
import { textOf } from "@tests/call-tool-result.js";
import { fakeLibrdKafkaError } from "@tests/factories/librdkafka.js";
import { kafkaRuntime } from "@tests/factories/runtime.js";
import { getMockedClientManager } from "@tests/stubs/index.js";
import { describe, expect, it, vi } from "vitest";
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
 *  defaults so tests only set the fields they care about. `error` is
 *  typed as `LibrdKafkaError | null | undefined` deliberately: the
 *  upstream `.d.ts` declares it `LibrdKafkaError | undefined`, but at
 *  runtime kafkajs-compat populates `error: null` for successful
 *  partitions. The factory exposes that runtime shape so tests can pin
 *  both the explicit-null path and the real-error path. */
function fakeFetchedPartition(overrides: {
  partition: number;
  offset?: string;
  metadata?: string | null;
  leaderEpoch?: number | null;
  error?: LibrdKafkaError | null;
}): FetchOffsetsPartition {
  return {
    offset: "100",
    metadata: null,
    leaderEpoch: null,
    ...overrides,
  } as FetchOffsetsPartition;
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

/** Build a `GroupDescription` fixture that explicitly does NOT match the
 *  dead-tombstone fingerprint, so `groupExists` returns `true` on the
 *  probe path. Tests that want to mock fetchOffsets returning `[]` for a
 *  REAL never-committed group must seed describeGroups with one of these. */
function fakeRealGroup(groupId: string): GroupDescription {
  return {
    groupId,
    members: [],
    protocol: "range",
    isSimpleConsumerGroup: false,
    protocolType: "consumer",
    partitionAssignor: "range",
    state: KafkaJS.ConsumerGroupStates.EMPTY,
    type: KafkaJS.ConsumerGroupTypes.CONSUMER,
    coordinator: { id: 0, host: "broker.example.com", port: 9092 },
  };
}

/** Build a `GroupDescription` shaped like the CCloud unknown-group
 *  tombstone (state=Dead, no members, empty protocol/partitionAssignor).
 *  Used by probe-path tests to drive `groupExists` to return `false`
 *  without the broker rejection. */
function fakeUnknownGroupTombstone(groupId: string): GroupDescription {
  return {
    groupId,
    members: [],
    protocol: "",
    isSimpleConsumerGroup: false,
    protocolType: "",
    partitionAssignor: "",
    state: KafkaJS.ConsumerGroupStates.DEAD,
    type: KafkaJS.ConsumerGroupTypes.CONSUMER,
    coordinator: { id: 0, host: "broker.example.com", port: 9092 },
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

  describe("handle()", () => {
    const handler = new GetConsumerGroupLagHandler();

    it("should forward groupId verbatim to admin.fetchOffsets and not pass a topics field when the filter is omitted", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchOffsets.mockResolvedValue([]);
      // Empty fetchOffsets triggers the existence probe; seed it with a
      // real (non-tombstone) group so the handler continues past.
      admin.describeGroups.mockResolvedValue({
        groups: [fakeRealGroup("g1")],
      });

      await handler.handle(kafkaRuntime(clientManager), { groupId: "g1" });

      expect(admin.fetchOffsets).toHaveBeenCalledOnce();
      expect(admin.fetchOffsets).toHaveBeenCalledWith({ groupId: "g1" });
    });

    it("should forward groupId and a topics filter together when the filter is supplied", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchOffsets.mockResolvedValue([]);
      // Empty fetchOffsets triggers the existence probe; seed describeGroups
      // with a real group so the handler proceeds to the topics-filter loop.
      admin.describeGroups.mockResolvedValue({
        groups: [fakeRealGroup("g1")],
      });
      // The filter is forwarded so the broker can server-side-restrict; the
      // handler still verifies the never-committed filter topics exist on
      // the cluster via fetchTopicMetadata.
      admin.fetchTopicMetadata.mockImplementation(async (options) => ({
        topics: (options?.topics ?? []).map((name) => ({
          name,
          partitions: [],
        })),
      }));

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

    it("should treat a partition whose error field is explicitly null (kafkajs-compat's no-error sentinel) as a successful partition and compute lag normally", async () => {
      // The kafkajs-compat layer populates `error: null` on the
      // FetchOffsetsPartition shape for successful partitions, even
      // though the upstream `.d.ts` declares the field as
      // `LibrdKafkaError | undefined`. A `!== undefined` check would
      // see `null` as "error present" and crash dereferencing
      // `null.code`. The handler uses `!= null` (loose) so both
      // `undefined` and `null` go through the no-error path.
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchOffsets.mockResolvedValue([
        {
          topic: "orders",
          partitions: [
            fakeFetchedPartition({
              partition: 0,
              offset: "80",
              error: null,
            }),
          ],
        },
      ]);
      admin.fetchTopicOffsets.mockResolvedValue([
        fakeWatermark({ partition: 0, low: "0", high: "100" }),
      ]);

      const result = await handler.handle(kafkaRuntime(clientManager), {
        groupId: "g1",
      });

      expect(result.isError, textOf(result)).not.toBe(true);
      const payload = result.structuredContent as GetConsumerGroupLagResponse;
      expect(payload.topics[0]!.partitions[0]).toEqual({
        partition: 0,
        committedOffset: "80",
        highWatermark: "100",
        lag: 20,
        metadata: null,
        leaderEpoch: null,
      });
      expect(payload.totalLag).toBe(20);
    });

    it("should surface a per-partition broker error as {committedOffset: null, lag: null, error: {code, message}} and exclude that partition from totalLag", async () => {
      // `FetchOffsetsPartition.error` is set when the broker reports a
      // per-partition failure on the OffsetFetch response (leader
      // unavailable, partition-level authorization failure, etc.). The
      // partition's `offset` value is meaningless in that case, so
      // computing lag from it would either throw on a non-numeric
      // sentinel or surface a wildly wrong number. The handler routes
      // these partitions into the same null/null shape as the
      // never-committed sentinel, with an `error` field carrying the
      // librdkafka `code` and `message` so the caller can act on the
      // specific failure.
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchOffsets.mockResolvedValue([
        {
          topic: "orders",
          partitions: [
            fakeFetchedPartition({ partition: 0, offset: "50" }),
            fakeFetchedPartition({
              partition: 1,
              offset: "0",
              error: fakeLibrdKafkaError({
                code: KafkaJS.ErrorCodes.ERR_GROUP_AUTHORIZATION_FAILED,
                message: "Broker: Group authorization failed",
              }),
            }),
          ],
        },
      ]);
      admin.fetchTopicOffsets.mockResolvedValue([
        fakeWatermark({ partition: 0, high: "100" }),
        fakeWatermark({ partition: 1, high: "200" }),
      ]);

      const result = await handler.handle(kafkaRuntime(clientManager), {
        groupId: "g1",
      });

      const payload = result.structuredContent as GetConsumerGroupLagResponse;
      const partitions = payload.topics[0]!.partitions;
      expect(partitions[1]).toEqual({
        partition: 1,
        committedOffset: null,
        highWatermark: "200",
        lag: null,
        metadata: null,
        leaderEpoch: null,
        error: {
          code: KafkaJS.ErrorCodes.ERR_GROUP_AUTHORIZATION_FAILED,
          message: "Broker: Group authorization failed",
        },
      });
      // Only partition 0's lag (50) counts; partition 1 is excluded.
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

    it("should return zero topics and totalLag:0 when admin.fetchOffsets resolves empty and the existence probe confirms the group exists", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchOffsets.mockResolvedValue([]);
      // CCloud's fetchOffsets returns `[]` for both "unknown group" and
      // "real group, never committed"; the probe disambiguates. A
      // non-tombstone describeGroups response means the group exists —
      // proceed to the zero-topics-zero-lag success path.
      admin.describeGroups.mockResolvedValue({
        groups: [fakeRealGroup("g1")],
      });

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

    it("should surface the friendly not-found error when fetchOffsets resolves empty and the probe returns the CCloud dead-tombstone shape", async () => {
      // This is the path the live integration test discovered: CCloud's
      // fetchOffsets resolves cleanly with `[]` for an unknown group ID
      // rather than rejecting with ERR_GROUP_ID_NOT_FOUND. The handler
      // probes via describeGroups, which on CCloud returns the
      // state=Dead/empty-protocol tombstone shape. That fingerprint maps
      // to the same friendly tool-level error as the documented
      // rejection path.
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchOffsets.mockResolvedValue([]);
      admin.describeGroups.mockResolvedValue({
        groups: [fakeUnknownGroupTombstone("ghost-group")],
      });

      const result = await handler.handle(kafkaRuntime(clientManager), {
        groupId: "ghost-group",
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(
        'Consumer group "ghost-group" not found on this cluster.',
      );
    });

    it("should surface the friendly not-found error when fetchOffsets resolves empty and the probe describeGroups rejects with ERR_GROUP_ID_NOT_FOUND", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchOffsets.mockResolvedValue([]);
      admin.describeGroups.mockRejectedValue(fakeNotFoundError());

      const result = await handler.handle(kafkaRuntime(clientManager), {
        groupId: "ghost-group",
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(
        'Consumer group "ghost-group" not found on this cluster.',
      );
    });

    it("should surface the friendly not-found error when the probe returns a per-group GroupDescription.error with ERR_GROUP_ID_NOT_FOUND", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchOffsets.mockResolvedValue([]);
      admin.describeGroups.mockResolvedValue({
        groups: [
          {
            ...fakeRealGroup("ghost-group"),
            error: fakeNotFoundError(),
          },
        ],
      });

      const result = await handler.handle(kafkaRuntime(clientManager), {
        groupId: "ghost-group",
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(
        'Consumer group "ghost-group" not found on this cluster.',
      );
    });

    it("should NOT call describeGroups (probe is skipped) when fetchOffsets returns at least one topic", async () => {
      // The probe only fires on the empty-result path. A happy-path call
      // pays nothing for the existence-disambiguation logic.
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchOffsets.mockResolvedValue([
        {
          topic: "orders",
          partitions: [fakeFetchedPartition({ partition: 0, offset: "10" })],
        },
      ]);
      admin.fetchTopicOffsets.mockResolvedValue([
        fakeWatermark({ partition: 0, high: "30" }),
      ]);

      await handler.handle(kafkaRuntime(clientManager), { groupId: "g1" });

      expect(admin.describeGroups).not.toHaveBeenCalled();
    });

    it("should surface group-not-found before topic-not-found when a topics-filter call hits an unknown group", async () => {
      // Ordering invariant: a caller who supplies both a wrong groupId and
      // a wrong topic gets "group not found" (the load-bearing fact), not
      // "topic not found" (which would mislead them into investigating
      // the topic spelling first).
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchOffsets.mockResolvedValue([]);
      admin.describeGroups.mockResolvedValue({
        groups: [fakeUnknownGroupTombstone("ghost-group")],
      });

      const result = await handler.handle(kafkaRuntime(clientManager), {
        groupId: "ghost-group",
        topics: ["does-not-exist"],
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(
        'Consumer group "ghost-group" not found on this cluster.',
      );
      // The topic-existence path (via the watermark cache) never fires
      // because the probe short-circuits first.
      expect(admin.fetchTopicOffsets).not.toHaveBeenCalled();
    });

    it("should propagate a non-not-found rejection from the probe describeGroups call", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchOffsets.mockResolvedValue([]);
      admin.describeGroups.mockRejectedValue(
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

    it("should propagate a non-not-found per-group GroupDescription.error from the probe with every librdkafka field preserved", async () => {
      // The per-group-error path in `groupExists` throws `desc.error`
      // verbatim, preserving `code` / `errno` / `origin` so downstream
      // logging and handling can see the real librdkafka failure
      // details. A naive `throw new Error(desc.error.message)` would
      // surface only the message string, and this test pins the throw
      // shape so that regression can't slip back in.
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchOffsets.mockResolvedValue([]);
      admin.describeGroups.mockResolvedValue({
        groups: [
          {
            ...fakeRealGroup("g1"),
            error: fakeLibrdKafkaError({
              code: KafkaJS.ErrorCodes.ERR_GROUP_AUTHORIZATION_FAILED,
              message: "Broker: Group authorization failed",
            }),
          },
        ],
      });

      await expect(
        handler.handle(kafkaRuntime(clientManager), { groupId: "g1" }),
      ).rejects.toMatchObject({
        code: KafkaJS.ErrorCodes.ERR_GROUP_AUTHORIZATION_FAILED,
        errno: KafkaJS.ErrorCodes.ERR_GROUP_AUTHORIZATION_FAILED,
        origin: "kafka",
        message: "Broker: Group authorization failed",
      });
    });

    it("should accumulate totalLag in BigInt so a cross-partition sum that exceeds Number.MAX_SAFE_INTEGER saturates rather than silently losing precision", async () => {
      // Per-partition `lag` values are individually narrowed to JS
      // Number, but a JS-Number running total `totalLag += row.lag`
      // would silently lose precision once K partitions accumulate past
      // 2^53 - 1. The accumulator stays in BigInt across partitions and
      // narrows once at the end via the same `narrowMessageCount`
      // saturation guard the per-partition path uses.
      //
      // Each partition's `committedOffset: "0"`, `highWatermark:
      // String(MAX_SAFE_INTEGER)` gives a per-partition lag of exactly
      // `MAX_SAFE_INTEGER` (in-range). Two such partitions sum to
      // 2 * MAX_SAFE_INTEGER as a BigInt — well past the safe boundary,
      // so the cross-partition narrow saturates and the test pins
      // `totalLag === MAX_SAFE_INTEGER`. A JS-Number accumulator would
      // produce 2 * MAX_SAFE_INTEGER and fail this assertion.
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      const maxSafe = String(Number.MAX_SAFE_INTEGER);
      admin.fetchOffsets.mockResolvedValue([
        {
          topic: "huge",
          partitions: [
            fakeFetchedPartition({ partition: 0, offset: "0" }),
            fakeFetchedPartition({ partition: 1, offset: "0" }),
          ],
        },
      ]);
      admin.fetchTopicOffsets.mockResolvedValue([
        fakeWatermark({ partition: 0, low: "0", high: maxSafe }),
        fakeWatermark({ partition: 1, low: "0", high: maxSafe }),
      ]);

      const result = await handler.handle(kafkaRuntime(clientManager), {
        groupId: "g1",
      });

      const payload = result.structuredContent as GetConsumerGroupLagResponse;
      // Per-partition lag stays precise (each is in-range).
      expect(payload.topics[0]!.partitions[0]!.lag).toBe(
        Number.MAX_SAFE_INTEGER,
      );
      expect(payload.topics[0]!.partitions[1]!.lag).toBe(
        Number.MAX_SAFE_INTEGER,
      );
      // Cross-partition totalLag saturates because the BigInt sum
      // (2 * MAX_SAFE_INTEGER) exceeds the safe boundary.
      expect(payload.totalLag).toBe(Number.MAX_SAFE_INTEGER);
      // The Wacky log fires exactly once — for the totalLag narrowing,
      // not for the per-partition narrowings (each in-range).
      expect(warnSpy).toHaveBeenCalledOnce();
    });

    it("should include a never-committed topic (in the filter but not in fetchOffsets output) as {topic, partitions: []} when its existence is confirmed via fetchTopicMetadata", async () => {
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
      admin.fetchTopicOffsets.mockResolvedValue([
        fakeWatermark({ partition: 0, high: "30" }),
      ]);
      // shipments is verified via metadata, not via the watermark fetch
      // — its watermarks are never needed since the group has no commits
      // on it.
      admin.fetchTopicMetadata.mockResolvedValue({
        topics: [{ name: "shipments", partitions: [] }],
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
      // The never-committed-topic path does NOT pay the per-partition
      // watermark cost — only `orders` (the committed topic) is fetched.
      expect(admin.fetchTopicOffsets).toHaveBeenCalledOnce();
      expect(admin.fetchTopicOffsets).toHaveBeenCalledWith("orders");
    });

    it("should normalize the bare-array runtime shape of fetchTopicMetadata's response (the upstream .d.ts declares `{topics: [...]}` but the kafkajs-compat runtime resolves with the bare array)", async () => {
      // Long-standing upstream type/runtime mismatch tracked at
      // confluentinc/confluent-kafka-javascript#367. A non-defensive
      // `metadata.topics.map(...)` crashes against the bare-array
      // runtime shape with "Cannot read properties of undefined" — the
      // exact failure mode the live integration test surfaced.
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchOffsets.mockResolvedValue([]);
      admin.describeGroups.mockResolvedValue({
        groups: [fakeRealGroup("g1")],
      });
      // Bare array, NOT wrapped in {topics: [...]} — matches the actual
      // runtime shape that the .d.ts misrepresents.
      admin.fetchTopicMetadata.mockResolvedValue([
        { name: "shipments", partitions: [] },
      ] as unknown as Awaited<ReturnType<typeof admin.fetchTopicMetadata>>);

      const result = await handler.handle(kafkaRuntime(clientManager), {
        groupId: "g1",
        topics: ["shipments"],
      });

      expect(result.isError, textOf(result)).not.toBe(true);
      const payload = result.structuredContent as GetConsumerGroupLagResponse;
      expect(payload.topics).toEqual([{ topic: "shipments", partitions: [] }]);
    });

    it("should batch fetchTopicMetadata into a single call when verifying multiple never-committed filter topics", async () => {
      // Perf invariant: K never-committed filter topics produce ONE
      // metadata round trip, not K. A regression that fanned the
      // existence check back out into a per-topic loop would fail this
      // call-count assertion.
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchOffsets.mockResolvedValue([]);
      admin.describeGroups.mockResolvedValue({
        groups: [fakeRealGroup("g1")],
      });
      admin.fetchTopicMetadata.mockResolvedValue({
        topics: [
          { name: "alpha", partitions: [] },
          { name: "bravo", partitions: [] },
          { name: "charlie", partitions: [] },
        ],
      });

      await handler.handle(kafkaRuntime(clientManager), {
        groupId: "g1",
        topics: ["alpha", "bravo", "charlie"],
      });

      expect(admin.fetchTopicMetadata).toHaveBeenCalledOnce();
      expect(admin.fetchTopicMetadata).toHaveBeenCalledWith({
        topics: ["alpha", "bravo", "charlie"],
      });
    });

    it("should surface a list-style not-found error citing every filter candidate when a batched fetchTopicMetadata rejects without identifying the missing topic", async () => {
      // The kafkajs-compat surface rejects a batched metadata call on
      // the first missing topic without telling us which one triggered
      // the failure. Rather than pay K extra per-topic round-trips to
      // identify it, the handler surfaces the full candidate list — the
      // caller already knows the topics they typed and can spot the
      // typo themselves.
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchOffsets.mockResolvedValue([]);
      admin.describeGroups.mockResolvedValue({
        groups: [fakeRealGroup("g1")],
      });
      admin.fetchTopicMetadata.mockRejectedValue(
        new KafkaJS.KafkaJSError("Broker: Unknown topic or partition", {
          code: KafkaJS.ErrorCodes.ERR_UNKNOWN_TOPIC_OR_PART,
        }),
      );

      const result = await handler.handle(kafkaRuntime(clientManager), {
        groupId: "g1",
        topics: ["alpha", "bravo"],
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(
        "Topic not found in [alpha, bravo] on this cluster.",
      );
      // The simplification deletes the per-topic-probe fallback path:
      // fetchTopicMetadata is called exactly once (the batch), not K+1
      // times.
      expect(admin.fetchTopicMetadata).toHaveBeenCalledOnce();
    });

    it("should surface a friendly 'Topic <name> not found' error when the group has committed offsets for a topic that has since been deleted from the cluster", async () => {
      // Kafka retains a group's committed offsets independently of the
      // topic until `offsets.retention.minutes` expires, so the broker
      // can return a non-empty fetchOffsets result for a topic the
      // watermark fetch then can't resolve. Without the catch around
      // `watermarkCache(topic)` inside the committed-offsets loop, the
      // raw librdkafka error would leak through; with it, the deleted
      // topic gets the same friendly mapping as a filtered-but-unknown
      // topic.
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchOffsets.mockResolvedValue([
        {
          topic: "deleted-since-commit",
          partitions: [fakeFetchedPartition({ partition: 0, offset: "10" })],
        },
      ]);
      admin.fetchTopicOffsets.mockRejectedValue(
        new KafkaJS.KafkaJSError("Broker: Unknown topic or partition", {
          code: KafkaJS.ErrorCodes.ERR_UNKNOWN_TOPIC_OR_PART,
        }),
      );

      const result = await handler.handle(kafkaRuntime(clientManager), {
        groupId: "g1",
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(
        'Topic "deleted-since-commit" not found on this cluster.',
      );
    });

    it("should surface a friendly 'Topic <name> not found' error when a filtered topic does not exist on the cluster (metadata fetch rejects)", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchOffsets.mockResolvedValue([]);
      // The group exists (probe seed); the unknown-topic path is what's
      // under test here, not the unknown-group path.
      admin.describeGroups.mockResolvedValue({
        groups: [fakeRealGroup("g1")],
      });
      // fetchTopicMetadata rejects with the broker-issued unknown-topic
      // code for the filtered topic — same posture get-partition-offsets
      // takes for its own "topic not found" mapping.
      admin.fetchTopicMetadata.mockRejectedValue(
        new KafkaJS.KafkaJSError("Broker: Unknown topic or partition", {
          code: KafkaJS.ErrorCodes.ERR_UNKNOWN_TOPIC_OR_PART,
        }),
      );

      const result = await handler.handle(kafkaRuntime(clientManager), {
        groupId: "g1",
        topics: ["does-not-exist"],
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(
        'Topic "does-not-exist" not found on this cluster.',
      );
    });

    it("should surface the same 'Topic <name> not found' error when fetchTopicMetadata rejects with the local-side ERR__UNKNOWN_TOPIC code", async () => {
      // ERR_UNKNOWN_TOPIC_OR_PART is broker-issued (single underscore);
      // ERR__UNKNOWN_TOPIC is client-local (double underscore — fires
      // when librdkafka's own metadata cache rejects the topic before
      // the broker is consulted). Both map to the same friendly error.
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchOffsets.mockResolvedValue([]);
      // The group exists; the unknown-topic path is what's under test.
      admin.describeGroups.mockResolvedValue({
        groups: [fakeRealGroup("g1")],
      });
      admin.fetchTopicMetadata.mockRejectedValue(
        new KafkaJS.KafkaJSError("Local: Unknown topic", {
          code: KafkaJS.ErrorCodes.ERR__UNKNOWN_TOPIC,
        }),
      );

      const result = await handler.handle(kafkaRuntime(clientManager), {
        groupId: "g1",
        topics: ["mystery-topic"],
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(
        'Topic "mystery-topic" not found on this cluster.',
      );
    });

    it("should surface the same 'Topic <name> not found' error when fetchTopicMetadata resolves cleanly with the requested topic absent from the response", async () => {
      // Defensive against kafkajs-compat implementations that silently
      // omit unknown topics from the returned `topics` array rather than
      // rejecting. The helper inspects the response and routes that
      // shape through the same `topicNotFound` arm as the rejection
      // path above.
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchOffsets.mockResolvedValue([]);
      admin.describeGroups.mockResolvedValue({
        groups: [fakeRealGroup("g1")],
      });
      admin.fetchTopicMetadata.mockResolvedValue({ topics: [] });

      const result = await handler.handle(kafkaRuntime(clientManager), {
        groupId: "g1",
        topics: ["silently-omitted-topic"],
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(
        'Topic "silently-omitted-topic" not found on this cluster.',
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
