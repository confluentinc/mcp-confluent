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
  fetchPartitionWatermarks,
  type PartitionWatermark,
} from "@src/confluent/tools/handlers/kafka/partition-watermarks.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { logger } from "@src/logger.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { z } from "zod";

export const getPartitionOffsetsArgs = z.object({
  topicName: z
    .string()
    .nonempty()
    .describe("Name of the Kafka topic to fetch partition offsets for."),
  partition: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "Optional. Restrict the response to this partition (0-indexed). " +
        "Omit to return every partition of the topic.",
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
 * One partition's offset metadata as the tool returns it. `lowWatermark` and
 * `highWatermark` are strings to preserve int64 precision past JS's 2^53
 * safe-integer boundary; `messageCount` is a `Number` because the BigInt
 * subtraction is done server-side and asking an LLM caller to subtract two
 * int64-typed strings is the wrong ergonomic trade.
 */
export type PartitionOffsetInfo = {
  partition: number;
  lowWatermark: string;
  highWatermark: string;
  messageCount: number;
};

/** Structured response payload mirrored into `result.structuredContent`. */
export type GetPartitionOffsetsResponse = {
  topicName: string;
  partitions: PartitionOffsetInfo[];
};

/**
 * Narrow {@link BigInt} subtraction to a JS `Number`, saturating at
 * {@link Number.MAX_SAFE_INTEGER} when the result would lose precision.
 * The narrow path is the only one expected to fire in practice (even a
 * million-msg/sec partition with infinite retention takes ~285 years to
 * exceed 2^53 - 1); the saturation arm is a defensive sentinel — hence the
 * `Wacky --` log signaling "this branch firing means something genuinely
 * surprising happened".
 */
function narrowMessageCount(
  diff: bigint,
  topicName: string,
  partition: number,
  low: string,
  high: string,
): number {
  const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
  if (diff > maxSafe) {
    logger.warn(
      { topicName, partition, low, high },
      "Wacky -- messageCount BigInt subtraction exceeds Number.MAX_SAFE_INTEGER; saturating to MAX_SAFE_INTEGER",
    );
    return Number.MAX_SAFE_INTEGER;
  }
  return Number(diff);
}

function mapToPartitionOffsetInfo(
  topicName: string,
  watermark: PartitionWatermark,
): PartitionOffsetInfo {
  const low = BigInt(watermark.low);
  const high = BigInt(watermark.high);
  const diff = high - low;
  return {
    partition: watermark.partition,
    lowWatermark: watermark.low,
    highWatermark: watermark.high,
    messageCount: narrowMessageCount(
      diff,
      topicName,
      watermark.partition,
      watermark.low,
      watermark.high,
    ),
  };
}

/**
 * Read-only tool that returns per-partition low/high watermarks (and the
 * derived message count) for a single Kafka topic. Thin wrapper over the
 * broker's `Admin.fetchTopicOffsets` admin call — the metadata primitive
 * that `consume-messages` already relies on internally for `start:
 * "earliest" / "latest" / {timestamp} / {tail}` resolution but doesn't
 * surface in its response. Closes #480.
 */
export class GetPartitionOffsetsHandler extends BaseToolHandler {
  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const parsed = getPartitionOffsetsArgs.parse(toolArguments);
    const { connId, clientManager } = this.resolveSoleConnection(runtime);
    const resolved = resolveKafkaClusterArgs(parsed, runtime, connId);

    const admin = await clientManager.getKafkaAdminClient(
      resolved.clusterId,
      resolved.envId,
    );
    try {
      let watermarks: PartitionWatermark[];
      try {
        watermarks = await fetchPartitionWatermarks(admin, parsed.topicName);
      } catch (err: unknown) {
        // Don't leak librdkafka's raw text — the issue is explicit that the
        // tool-level message is what callers should see. Log the underlying
        // error so operators debugging from the server side can still find
        // the librdkafka detail.
        logger.warn(
          { error: err, topicName: parsed.topicName },
          `fetchTopicOffsets rejected for "${parsed.topicName}" — surfacing as topic-not-found`,
        );
        return this.createResponse(
          `Topic "${parsed.topicName}" not found on this cluster.`,
          true,
        );
      }

      if (watermarks.length === 0) {
        return this.createResponse(
          `Topic "${parsed.topicName}" not found on this cluster.`,
          true,
        );
      }

      if (parsed.partition !== undefined) {
        const numPartitions = watermarks.length;
        const requested = parsed.partition;
        const match = watermarks.find((w) => w.partition === requested);
        if (!match) {
          return this.createResponse(
            `Topic "${parsed.topicName}" has ${numPartitions} partition(s) ` +
              `(0..${numPartitions - 1}); requested partition ${requested} is out of range.`,
            true,
          );
        }
        watermarks = [match];
      }

      const payload: GetPartitionOffsetsResponse = {
        topicName: parsed.topicName,
        partitions: watermarks.map((w) =>
          mapToPartitionOffsetInfo(parsed.topicName, w),
        ),
      };

      const summary =
        `Partition offsets for "${parsed.topicName}" ` +
        `(${payload.partitions.length} partition(s)):\n` +
        JSON.stringify(payload, null, 2);

      return this.createStructuredResponse(summary, payload);
    } finally {
      await disposeIfOAuth(runtime, connId, admin);
    }
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.GET_PARTITION_OFFSETS,
      description:
        "Return per-partition low/high watermarks and message counts for a Kafka topic. " +
        "Use this to size a backfill, measure lag relative to a known offset, or check whether a topic is still receiving writes — without consuming. " +
        "Pass `partition` to restrict the response to a single partition.",
      inputSchema: getPartitionOffsetsArgs.shape,
      annotations: READ_ONLY,
    };
  }

  readonly category = ToolCategory.Kafka;
  readonly predicate = kafkaBootstrapOrOAuth;
}
