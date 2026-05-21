import { KafkaJS } from "@confluentinc/kafka-javascript";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  READ_ONLY,
  ToolCategory,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import {
  disposeIfOAuth,
  formatKafkaError,
  resolveKafkaClusterArgs,
} from "@src/confluent/tools/cluster-arg-resolvers.js";
import { kafkaBootstrapOrOAuth } from "@src/confluent/tools/connection-predicates.js";
import {
  fetchPartitionWatermarks,
  narrowMessageCount,
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
    messageCount: narrowMessageCount(diff, {
      topicName,
      partition: watermark.partition,
      low: watermark.low,
      high: watermark.high,
    }),
  };
}

/**
 * Read-only tool that returns per-partition low/high watermarks (and the
 * derived message count) for a single Kafka topic. Thin wrapper over the
 * broker's `Admin.fetchTopicOffsets` admin call — the metadata primitive
 * that `consume-messages` already relies on internally for `start:
 * "earliest" / "latest" / {timestamp} / {tail}` resolution but doesn't
 * surface in its response.
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
        // Two distinct librdkafka codes report the same conceptual failure:
        //   - ERR_UNKNOWN_TOPIC_OR_PART (broker-issued, single underscore)
        //   - ERR__UNKNOWN_TOPIC (local-side, double underscore — fires when
        //     the client's own metadata cache rejects the topic before
        //     reaching the broker)
        // Only those two get the friendly "topic not found" message;
        // everything else (auth denials, TLS failures, broker timeouts,
        // unknown shapes) flows through formatKafkaError so callers see
        // actionable signal instead of a misleading not-found label.
        const isUnknownTopic =
          err instanceof KafkaJS.KafkaJSError &&
          (err.code === KafkaJS.ErrorCodes.ERR_UNKNOWN_TOPIC_OR_PART ||
            err.code === KafkaJS.ErrorCodes.ERR__UNKNOWN_TOPIC);
        if (isUnknownTopic) {
          logger.warn(
            { error: err, topicName: parsed.topicName },
            `fetchTopicOffsets rejected for "${parsed.topicName}" — surfacing as topic-not-found`,
          );
          return this.createResponse(
            `Topic "${parsed.topicName}" not found on this cluster.`,
            true,
          );
        }
        return this.createResponse(
          `Failed to fetch partition offsets for "${parsed.topicName}": ${formatKafkaError(err)}`,
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
