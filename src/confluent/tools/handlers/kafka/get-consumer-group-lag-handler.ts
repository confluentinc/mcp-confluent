import { KafkaJS } from "@confluentinc/kafka-javascript";
import type { FetchOffsetsPartition } from "@confluentinc/kafka-javascript/types/kafkajs.js";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  READ_ONLY,
  ToolCategory,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import {
  disposeIfOAuth,
  resolveKafkaClusterArgs,
} from "@src/confluent/tools/cluster-arg-resolvers.js";
import { kafkaBootstrapOrOAuth } from "@src/confluent/tools/connection-predicates.js";
import {
  describeGroupOutcome,
  isGroupIdNotFoundError,
  notFoundGroupMessage,
} from "@src/confluent/tools/handlers/kafka/consumer-group-helpers.js";
import {
  createWatermarkCache,
  narrowMessageCount,
  type PartitionWatermark,
  type WatermarkCache,
} from "@src/confluent/tools/handlers/kafka/partition-watermarks.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { logger } from "@src/logger.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { z } from "zod";

export const getConsumerGroupLagArgs = z.object({
  groupId: z
    .string()
    .min(1)
    .describe(
      "Consumer group ID to compute lag for. Discover groups via list-consumer-groups.",
    ),
  topics: z
    .array(z.string().min(1))
    .nonempty()
    .optional()
    .describe(
      "Restrict lag computation to these topics. " +
        "Omit to compute lag for every topic the group has committed offsets on.",
    ),
  cluster_id: z
    .string()
    .optional()
    .describe(
      "Confluent Cloud logical Kafka cluster ID (lkc-...). Discover via list-clusters.",
    ),
  environment_id: z
    .string()
    .optional()
    .describe(
      "Confluent Cloud environment ID (env-...) that owns the cluster. Discover via list-environments.",
    ),
});

/**
 * Per-partition lag row as the tool returns it. `committedOffset` /
 * `highWatermark` are strings to preserve int64 precision past JS's 2^53
 * safe-integer boundary; `lag` is a `Number` because the BigInt subtraction
 * is done server-side and asking an LLM caller to subtract two int64-typed
 * strings is the wrong ergonomic trade. `null` for both `committedOffset`
 * and `lag` marks a partition where the lag is unknown — either the group
 * has never committed (distinct from a zero-lag partition the group is
 * caught up on) or the broker reported a per-partition error on the
 * OffsetFetch response (see {@link error}).
 */
export type ConsumerGroupLagPartition = {
  partition: number;
  committedOffset: string | null;
  highWatermark: string;
  lag: number | null;
  metadata: string | null;
  leaderEpoch: number | null;
  /**
   * Set when the broker reported a per-partition error on the
   * OffsetFetch response (e.g., leader unavailable, partition-level
   * authorization failure). `committedOffset` and `lag` are `null` in
   * this case — the broker's `offset` value is not meaningful when an
   * error is attached — and the partition is excluded from `totalLag`.
   * Surfacing the `code` and `message` lets the caller act on the
   * specific failure rather than guessing why the lag is unknown.
   */
  error?: { code: number; message: string };
};

/** Per-topic group of {@link ConsumerGroupLagPartition} rows. */
export type ConsumerGroupLagTopic = {
  topic: string;
  partitions: ConsumerGroupLagPartition[];
};

/** Structured response payload mirrored into `result.structuredContent`. */
export type GetConsumerGroupLagResponse = {
  groupId: string;
  topics: ConsumerGroupLagTopic[];
  totalLag: number;
};

/**
 * Read-only tool that computes live offset lag for a single Kafka
 * consumer group, returning per-(topic, partition) {committed, high, lag}
 * rows and a total lag count. Combines `admin.fetchOffsets({groupId})`
 * (committed offsets) with the shared `fetchPartitionWatermarks` helper
 * (high watermarks), then BigInt-subtracts per partition. A partition the
 * group has never committed to surfaces as {committedOffset: null,
 * lag: null} and is excluded from the `totalLag` sum. Lag may briefly go
 * negative during a consumer-group rebalance (committed offset captured
 * at a different isolation level than the watermark snapshot); the value
 * is surfaced as-is rather than clamped, since clamping would hide a real
 * if rare state.
 */
export class GetConsumerGroupLagHandler extends BaseToolHandler {
  readonly category = ToolCategory.Kafka;
  readonly predicate = kafkaBootstrapOrOAuth;

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.GET_CONSUMER_GROUP_LAG,
      description:
        "Compute live offset lag for a single Kafka consumer group. " +
        "Returns per-(topic, partition) {committedOffset, highWatermark, lag} rows " +
        "and a total lag count across the group. " +
        "Pass `topics` to restrict the response to specific topics; " +
        "omit to compute lag for every topic the group has touched. " +
        "Partitions the group has never committed to surface with " +
        "`committedOffset: null` and `lag: null` and are excluded from `totalLag`.",
      inputSchema: getConsumerGroupLagArgs.shape,
      annotations: READ_ONLY,
    };
  }

  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const parsed = getConsumerGroupLagArgs.parse(toolArguments);
    const { connId, clientManager } = this.resolveConnection(
      runtime,
      toolArguments,
    );
    const { clusterId, envId } = resolveKafkaClusterArgs(
      parsed,
      runtime,
      connId,
    );
    const admin = await clientManager.getKafkaAdminClient(clusterId, envId);

    try {
      // 1. Fetch the group's committed offsets.
      let committedByTopic: Array<{
        topic: string;
        partitions: FetchOffsetsPartition[];
      }>;
      try {
        committedByTopic = await admin.fetchOffsets(
          parsed.topics
            ? { groupId: parsed.groupId, topics: parsed.topics }
            : { groupId: parsed.groupId },
        );
      } catch (err) {
        if (isGroupIdNotFoundError(err)) {
          return this.createResponse(
            notFoundGroupMessage(parsed.groupId),
            true,
          );
        }
        throw err;
      }

      // Disambiguate "unknown group" from "real group, no commits". CCloud's
      // fetchOffsets resolves with `[]` for an unknown group ID rather than
      // rejecting with ERR_GROUP_ID_NOT_FOUND (the documented path the catch
      // above handles), which means an empty result by itself can't tell the
      // caller whether the group exists or not. Probe via describeGroups
      // before continuing — only on the empty path, so happy-path calls pay
      // nothing.
      if (committedByTopic.length === 0) {
        const outcome = await describeGroupOutcome(admin, parsed.groupId);
        if (outcome.kind === "notFound") {
          return this.createResponse(
            notFoundGroupMessage(parsed.groupId),
            true,
          );
        }
        if (outcome.kind === "error") {
          // Propagate the raw librdkafka error so downstream handlers
          // and logs can inspect `code` / `errno` / `origin` rather
          // than just a message string.
          throw outcome.error;
        }
      }

      // 2. For each topic+partition the group has committed to, fetch the
      // partition's high watermark and compute lag = high - committed. A
      // topic the group has committed offsets for but that's since been
      // deleted from the cluster short-circuits with the same friendly
      // "Topic not found" error the filter-topics path uses below.

      const watermarkCache = createWatermarkCache(admin);
      const lagResult = await buildLagFromCommittedOffsets(
        parsed.groupId,
        committedByTopic,
        watermarkCache,
      );
      if (lagResult.kind === "topicNotFound") {
        return this.createResponse(lagResult.message, true);
      }
      const { topics: responseTopics, totalLagBigInt } = lagResult;

      // 3. If the caller passed `topics`, verify that any never-committed
      // filter topics exist on the cluster (so we can return
      // `{topic, partitions: []}` for each) and surface a friendly
      // "Topic not found" error for any that don't.

      if (parsed.topics) {
        const seenTopics = new Set(committedByTopic.map(({ topic }) => topic));
        const filterResult = await resolveNeverCommittedFilterTopics(
          parsed.topics,
          seenTopics,
          admin,
        );
        if (filterResult.kind === "topicNotFound") {
          return this.createResponse(filterResult.message, true);
        }
        responseTopics.push(...filterResult.topics);
      }

      // 4. Narrow the BigInt accumulator to a JS Number for the wire
      // payload, saturating at Number.MAX_SAFE_INTEGER (and emitting a
      // Wacky log) if the cross-partition sum exceeds the safe-integer
      // boundary even though each individual partition fit.

      const totalLag = narrowMessageCount(totalLagBigInt, {
        groupId: parsed.groupId,
        scope: "totalLag",
        topicCount: responseTopics.length,
      });

      const payload: GetConsumerGroupLagResponse = {
        groupId: parsed.groupId,
        topics: responseTopics,
        totalLag,
      };

      const summary =
        `Consumer group "${parsed.groupId}" has ${totalLag} message(s) of lag ` +
        `across ${responseTopics.length} topic(s).`;

      return this.createStructuredResponse(summary, payload);
    } finally {
      await disposeIfOAuth(runtime, connId, admin);
    }
  }
}

/**
 * Build one {@link ConsumerGroupLagPartition} row from a committed offset
 * and a paired watermark. Splits the never-committed sentinel
 * (`offset === "-1"`) from the real arithmetic path so the latter remains
 * a clean BigInt subtraction. Returns the raw BigInt diff (or `null` for
 * the never-committed case) alongside the row so the caller can
 * accumulate `totalLag` in BigInt across partitions and narrow once at
 * the end via {@link narrowMessageCount} — individual per-partition lags
 * each fit in `Number`, but their sum can still overflow the
 * safe-integer boundary.
 */
function buildLagRow(
  groupId: string,
  topic: string,
  committed: FetchOffsetsPartition,
  watermark: PartitionWatermark,
): { row: ConsumerGroupLagPartition; lagBigInt: bigint | null } {
  // Broker-reported per-partition error: the offset value isn't
  // meaningful (could be a sentinel, stale, or garbage), so surface the
  // error code and message verbatim and treat the lag as unknown.
  // Excluded from the cross-partition `totalLag` sum.
  if (committed.error !== null) {
    return {
      row: {
        partition: committed.partition,
        committedOffset: null,
        highWatermark: watermark.high,
        lag: null,
        metadata: committed.metadata,
        leaderEpoch: committed.leaderEpoch,
        error: {
          code: committed.error.code,
          message: committed.error.message,
        },
      },
      lagBigInt: null,
    };
  }
  if (committed.offset === "-1") {
    return {
      row: {
        partition: committed.partition,
        committedOffset: null,
        highWatermark: watermark.high,
        lag: null,
        metadata: committed.metadata,
        leaderEpoch: committed.leaderEpoch,
      },
      lagBigInt: null,
    };
  }
  const diff = BigInt(watermark.high) - BigInt(committed.offset);
  const lag = narrowMessageCount(diff, {
    groupId,
    topic,
    partition: committed.partition,
    committed: committed.offset,
    high: watermark.high,
  });
  return {
    row: {
      partition: committed.partition,
      committedOffset: committed.offset,
      highWatermark: watermark.high,
      lag,
      metadata: committed.metadata,
      leaderEpoch: committed.leaderEpoch,
    },
    lagBigInt: diff,
  };
}

/**
 * Two distinct librdkafka codes report the same conceptual failure:
 * `ERR_UNKNOWN_TOPIC_OR_PART` (broker-issued, single underscore) and
 * `ERR__UNKNOWN_TOPIC` (local-side, double underscore — fires when the
 * client's own metadata cache rejects the topic before the broker is
 * consulted). Both funnel into the same friendly "topic not found"
 * message; same posture get-partition-offsets takes.
 */
function isUnknownTopicError(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("code" in err)) {
    return false;
  }
  const code = (err as { code: unknown }).code;
  return (
    code === KafkaJS.ErrorCodes.ERR_UNKNOWN_TOPIC_OR_PART ||
    code === KafkaJS.ErrorCodes.ERR__UNKNOWN_TOPIC
  );
}

/**
 * Tagged-union outcome of {@link buildLagFromCommittedOffsets}. Shares
 * the `{kind: "topicNotFound", message: string}` arm shape with
 * {@link ResolveNeverCommittedTopicsResult} so the handler thunks both
 * through the same `createResponse(message, true)` call. The
 * `topicNotFound` arm fires when a topic the group still has committed
 * offsets for has since been deleted from the cluster — Kafka retains
 * group offsets independently of the topic until
 * offsets.retention.minutes expires, so the broker can hand back commits
 * for a topic the watermark fetch then can't resolve.
 */
type BuildLagResult =
  | {
      kind: "resolved";
      topics: ConsumerGroupLagTopic[];
      totalLagBigInt: bigint;
    }
  | { kind: "topicNotFound"; message: string };

/**
 * Iterate the group's committed offsets and produce per-(topic, partition)
 * lag rows paired with a BigInt running total. The accumulator stays in
 * BigInt so a sum that exceeds the safe-integer boundary stays precise;
 * narrow once at the end via {@link narrowMessageCount}. A
 * deleted-but-still-committed-to topic short-circuits with its name in
 * the `topicNotFound` arm — see {@link BuildLagResult}.
 */
async function buildLagFromCommittedOffsets(
  groupId: string,
  committedByTopic: ReadonlyArray<{
    topic: string;
    partitions: FetchOffsetsPartition[];
  }>,
  watermarkCache: WatermarkCache,
): Promise<BuildLagResult> {
  const topics: ConsumerGroupLagTopic[] = [];
  let totalLagBigInt = 0n;

  for (const { topic, partitions: committedPartitions } of committedByTopic) {
    let watermarks: PartitionWatermark[];
    try {
      watermarks = await watermarkCache(topic);
    } catch (err) {
      if (isUnknownTopicError(err)) {
        return {
          kind: "topicNotFound",
          message: notFoundTopicMessage(topic),
        };
      }
      throw err;
    }
    const watermarkByPartition = new Map<number, PartitionWatermark>(
      watermarks.map((w) => [w.partition, w]),
    );

    const rows: ConsumerGroupLagPartition[] = [];
    for (const committed of committedPartitions) {
      const watermark = watermarkByPartition.get(committed.partition);
      if (watermark === undefined) {
        logger.warn(
          { groupId, topic, partition: committed.partition },
          "Wacky -- committed offset reported for a partition with no matching watermark; skipping",
        );
        continue;
      }
      const { row, lagBigInt } = buildLagRow(
        groupId,
        topic,
        committed,
        watermark,
      );
      rows.push(row);
      if (lagBigInt !== null) {
        totalLagBigInt += lagBigInt;
      }
    }
    topics.push({ topic, partitions: rows });
  }

  return { kind: "resolved", topics, totalLagBigInt };
}

/**
 * Tagged-union outcome of {@link resolveNeverCommittedFilterTopics}.
 * `kind: "resolved"` means every filter topic exists on the cluster;
 * `kind: "topicNotFound"` means at least one filter topic is absent from
 * the cluster's metadata — the helper formats the user-facing message
 * directly (specific-topic when we have specificity, list-style when
 * the broker only tells us "one of these is wrong" without saying
 * which).
 */
type ResolveNeverCommittedTopicsResult =
  | { kind: "resolved"; topics: ConsumerGroupLagTopic[] }
  | { kind: "topicNotFound"; message: string };

/**
 * Verify each filter topic that didn't appear in the `fetchOffsets`
 * response (group never committed to them) exists on the cluster, via
 * `admin.fetchTopicMetadata` — the right primitive for a yes/no
 * existence question, where `fetchTopicOffsets` would fan out per
 * partition and discard the watermark data we don't need on this path.
 * Topics that exist but the group hasn't committed to surface as
 * `{topic, partitions: []}` in the `resolved` arm; topics that don't
 * exist short-circuit with a pre-formatted user-facing message in the
 * `topicNotFound` arm. Non-unknown-topic errors propagate via throw.
 *
 * Defensive against both unknown-topic surface shapes: librdkafka may
 * reject the batched call with `ERR_UNKNOWN_TOPIC_OR_PART` /
 * `ERR__UNKNOWN_TOPIC` (which doesn't identify which candidate
 * triggered it — we surface the full list in the message) or resolve
 * cleanly with the unknown topic absent from the returned `topics`
 * array (which does give us specificity).
 */
async function resolveNeverCommittedFilterTopics(
  filterTopics: readonly string[],
  seenTopics: ReadonlySet<string>,
  admin: KafkaJS.Admin,
): Promise<ResolveNeverCommittedTopicsResult> {
  const missing = filterTopics.filter((t) => !seenTopics.has(t));
  if (missing.length === 0) {
    return { kind: "resolved", topics: [] };
  }

  let topicMetadata: Awaited<ReturnType<typeof admin.fetchTopicMetadata>>;
  try {
    topicMetadata = await admin.fetchTopicMetadata({ topics: [...missing] });
  } catch (err) {
    if (!isUnknownTopicError(err)) throw err;
    // The batched call rejected with an unknown-topic code but doesn't
    // tell us which candidate triggered the failure. With K=1 there's
    // only one possibility so we can still name it; with K>1 surface
    // the full list so the caller can spot the typo without us paying
    // K extra round-trips to identify the specific one.
    const message =
      missing.length === 1
        ? notFoundTopicMessage(missing[0]!)
        : `Topic not found in [${missing.join(", ")}] on this cluster.`;
    return { kind: "topicNotFound", message };
  }

  // Defensive against the silently-omits-missing-topic surface shape:
  // locate the first requested topic that didn't come back, in
  // user-supplied order.
  const returnedNames = new Set(topicMetadata.map((t) => t.name));
  const firstMissing = missing.find((t) => !returnedNames.has(t));
  if (firstMissing !== undefined) {
    return {
      kind: "topicNotFound",
      message: notFoundTopicMessage(firstMissing),
    };
  }

  return {
    kind: "resolved",
    topics: missing.map((topic) => ({ topic, partitions: [] })),
  };
}

/**
 * Canonical user-facing "topic not found" message format. Centralizes
 * the phrasing so the step-2 (deleted-since-commit topic) and step-3
 * (filter topic missing from metadata) paths can't drift apart.
 */
function notFoundTopicMessage(topic: string): string {
  return `Topic "${topic}" not found on this cluster.`;
}
