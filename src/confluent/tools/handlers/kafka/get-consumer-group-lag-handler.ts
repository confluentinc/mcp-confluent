import { KafkaJS } from "@confluentinc/kafka-javascript";
import type { FetchOffsetsPartition } from "@confluentinc/kafka-javascript/types/kafkajs.js";
import type { GroupDescription } from "@confluentinc/kafka-javascript/types/rdkafka.js";
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
  isGroupIdNotFoundError,
  isUnknownGroupTombstone,
  notFoundGroupMessage,
} from "@src/confluent/tools/handlers/kafka/consumer-group-not-found.js";
import {
  createWatermarkCache,
  narrowMessageCount,
  type PartitionWatermark,
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
 * and `lag` marks a partition the group has never committed to — distinct
 * from a zero-lag partition the group is caught up on.
 */
export type ConsumerGroupLagPartition = {
  partition: number;
  committedOffset: string | null;
  highWatermark: string;
  lag: number | null;
  metadata: string | null;
  leaderEpoch: number | null;
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
 * if rare state. Closes #491.
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
    const { connId, clientManager } = this.resolveSoleConnection(runtime);
    const { clusterId, envId } = resolveKafkaClusterArgs(
      parsed,
      runtime,
      connId,
    );
    const admin = await clientManager.getKafkaAdminClient(clusterId, envId);

    try {
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
        const exists = await groupExists(admin, parsed.groupId);
        if (!exists) {
          return this.createResponse(
            notFoundGroupMessage(parsed.groupId),
            true,
          );
        }
      }

      const watermarkCache = createWatermarkCache(admin);
      const responseTopics: ConsumerGroupLagTopic[] = [];
      let totalLag = 0;

      for (const {
        topic,
        partitions: committedPartitions,
      } of committedByTopic) {
        const watermarks = await watermarkCache(topic);
        const watermarkByPartition = new Map<number, PartitionWatermark>(
          watermarks.map((w) => [w.partition, w]),
        );

        const rows: ConsumerGroupLagPartition[] = [];
        for (const committed of committedPartitions) {
          const watermark = watermarkByPartition.get(committed.partition);
          if (watermark === undefined) {
            logger.warn(
              {
                groupId: parsed.groupId,
                topic,
                partition: committed.partition,
              },
              "Wacky -- committed offset reported for a partition with no matching watermark; skipping",
            );
            continue;
          }
          const row = buildLagRow(parsed.groupId, topic, committed, watermark);
          rows.push(row);
          if (row.lag !== null) {
            totalLag += row.lag;
          }
        }
        responseTopics.push({ topic, partitions: rows });
      }

      if (parsed.topics) {
        const seenTopics = new Set(committedByTopic.map(({ topic }) => topic));
        for (const filterTopic of parsed.topics) {
          if (seenTopics.has(filterTopic)) continue;
          try {
            await watermarkCache(filterTopic);
          } catch (err) {
            if (isUnknownTopicError(err)) {
              return this.createResponse(
                `Topic "${filterTopic}" not found on this cluster.`,
                true,
              );
            }
            throw err;
          }
          responseTopics.push({ topic: filterTopic, partitions: [] });
        }
      }

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
 * Build one {@link ConsumerGroupLagPartition} row from a committed offset and
 * a paired watermark. Splits the never-committed sentinel (`offset === "-1"`)
 * from the real arithmetic path so the latter remains a clean BigInt
 * subtraction.
 */
function buildLagRow(
  groupId: string,
  topic: string,
  committed: FetchOffsetsPartition,
  watermark: PartitionWatermark,
): ConsumerGroupLagPartition {
  if (committed.offset === "-1") {
    return {
      partition: committed.partition,
      committedOffset: null,
      highWatermark: watermark.high,
      lag: null,
      metadata: committed.metadata,
      leaderEpoch: committed.leaderEpoch,
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
    partition: committed.partition,
    committedOffset: committed.offset,
    highWatermark: watermark.high,
    lag,
    metadata: committed.metadata,
    leaderEpoch: committed.leaderEpoch,
  };
}

/**
 * Best-effort group-existence probe used to disambiguate the
 * `fetchOffsets`-resolves-empty path. Returns `true` if the group is known
 * to exist on the cluster, `false` if the broker reported it as unknown
 * via any of the three shapes the project handles (top-level rejection,
 * per-group `GroupDescription.error` with the same code, or the
 * dead-tombstone — see {@link isUnknownGroupTombstone} for why the
 * tombstone path matters on Confluent Cloud). Propagates any other error.
 */
async function groupExists(
  admin: KafkaJS.Admin,
  groupId: string,
): Promise<boolean> {
  let result: { groups: GroupDescription[] };
  try {
    result = await admin.describeGroups([groupId]);
  } catch (err) {
    if (isGroupIdNotFoundError(err)) return false;
    throw err;
  }
  const desc = result.groups[0];
  if (desc === undefined) return false;
  if (desc.error !== undefined) {
    if (desc.error.code === KafkaJS.ErrorCodes.ERR_GROUP_ID_NOT_FOUND) {
      return false;
    }
    throw new Error(desc.error.message);
  }
  return !isUnknownGroupTombstone(desc);
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
  if (!(err instanceof KafkaJS.KafkaJSError)) return false;
  return (
    err.code === KafkaJS.ErrorCodes.ERR_UNKNOWN_TOPIC_OR_PART ||
    err.code === KafkaJS.ErrorCodes.ERR__UNKNOWN_TOPIC
  );
}
