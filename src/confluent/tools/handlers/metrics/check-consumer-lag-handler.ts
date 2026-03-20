/**
 * @fileoverview Handler for checking consumer group lag in Confluent Cloud using Metrics API
 */

import { ClientManager } from "@src/confluent/client-manager.js";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { EnvVar } from "@src/env-schema.js";
import { logger } from "@src/logger.js";
import { z } from "zod";
import {
  formatNumber,
  queryMetrics,
  getTimeRange,
  METRICS,
  FILTER_FIELDS,
} from "./metrics-helper.js";

/**
 * Input schema for check-consumer-lag tool
 */
const checkConsumerLagArguments = z.object({
  clusterId: z
    .string()
    .describe("Kafka cluster ID (e.g., lkc-xxxxx)")
    .refine((id) => id.startsWith("lkc-"), {
      message: "Cluster ID must start with 'lkc-'",
    }),
  consumerGroupId: z.string().describe("Consumer group ID to check"),
  warnThreshold: z
    .number()
    .default(1000)
    .describe("Lag threshold to trigger warning (default: 1000)"),
  includePerTopicLag: z
    .boolean()
    .default(false)
    .describe("Include per-topic lag breakdown"),
});

/**
 * Consumer lag data point from Metrics API
 */
interface LagDataPoint {
  timestamp: string;
  value: number;
  "metric.topic"?: string;
  "metric.partition"?: string;
}

/**
 * Handler for checking consumer group lag using Metrics API
 *
 * Checks consumer group lag using Confluent Cloud Metrics API including:
 * - Total lag across all partitions
 * - Max lag identification
 * - Per-topic lag breakdown (optional)
 * - Warning when lag exceeds threshold
 *
 * @example
 * Input:
 * {
 *   "clusterId": "lkc-12345",
 *   "consumerGroupId": "my-consumer-group",
 *   "warnThreshold": 1000,
 *   "includePerTopicLag": true
 * }
 *
 * Output:
 * Consumer Group: my-consumer-group
 *
 * Status: ⚠️  LAGGING
 * Total Lag: 15,234 messages
 *
 * Max Lag:
 *   • Topic: orders
 *   • Partition: 3
 *   • Lag: 15,000 messages
 *
 * Per-Topic Breakdown:
 *   • orders: 15,000 (3 partitions)
 *   • users: 234 (1 partition)
 */
export class CheckConsumerLagHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const { clusterId, consumerGroupId, warnThreshold, includePerTopicLag } =
      checkConsumerLagArguments.parse(toolArguments);

    try {
      logger.debug(
        {
          clusterId,
          consumerGroupId,
          warnThreshold,
          includePerTopicLag,
        },
        "Checking consumer group lag",
      );

      const telemetryClient =
        clientManager.getConfluentCloudTelemetryRestClient();

      // Query consumer lag metric from the last 5 minutes
      const timeRange = getTimeRange("5m");

      const groupBy = includePerTopicLag
        ? ["metric.topic", "metric.partition"]
        : [];

      const metricsResponse = await queryMetrics(telemetryClient, "cloud", {
        aggregations: [
          {
            metric: METRICS.CONSUMER_LAG_OFFSETS,
            agg: "SUM",
          },
        ],
        filters: [
          {
            field: FILTER_FIELDS.CLUSTER_ID,
            op: "EQ",
            value: clusterId,
          },
          {
            field: "metric.consumer_group_id",
            op: "EQ",
            value: consumerGroupId,
          },
        ],
        granularity: "PT1M",
        startTime: timeRange.start,
        endTime: timeRange.end,
        groupBy,
      });

      if (!metricsResponse.data || metricsResponse.data.length === 0) {
        throw new Error(
          `No lag data found for consumer group '${consumerGroupId}'. Consumer group may not exist or has no committed offsets.`,
        );
      }

      const lagData = metricsResponse.data as LagDataPoint[];

      // Calculate total lag and find max lag
      let totalLag = 0;
      let maxLag = 0;
      let maxLagTopic = "";
      let maxLagPartition = "";

      const topicLagMap = new Map<
        string,
        { lag: number; partitions: Set<string> }
      >();

      lagData.forEach((point) => {
        const lag = point.value;
        totalLag += lag;

        if (lag > maxLag) {
          maxLag = lag;
          maxLagTopic = point["metric.topic"] || "unknown";
          maxLagPartition = point["metric.partition"] || "unknown";
        }

        if (includePerTopicLag && point["metric.topic"]) {
          const topic = point["metric.topic"];
          const partition = point["metric.partition"] || "0";
          const existing = topicLagMap.get(topic) || {
            lag: 0,
            partitions: new Set<string>(),
          };
          topicLagMap.set(topic, {
            lag: existing.lag + lag,
            partitions: existing.partitions.add(partition),
          });
        }
      });

      // Build the response message
      let message = `Consumer Group: ${consumerGroupId}\n\n`;

      // Determine status
      const isLagging = totalLag > warnThreshold;
      const status = isLagging ? "⚠️  LAGGING" : "✓ HEALTHY";
      message += `Status: ${status}\n`;
      message += `Total Lag: ${formatNumber(totalLag)} messages\n`;

      // Add max lag information
      if (maxLag > 0) {
        message += `\nMax Lag:\n`;
        message += `  • Topic: ${maxLagTopic}\n`;
        message += `  • Partition: ${maxLagPartition}\n`;
        message += `  • Lag: ${formatNumber(maxLag)} messages\n`;
      }

      // Add per-topic breakdown if requested and available
      if (includePerTopicLag && topicLagMap.size > 0) {
        message += `\nPer-Topic Breakdown:\n`;
        const sortedTopics = Array.from(topicLagMap.entries()).sort(
          (a, b) => b[1].lag - a[1].lag,
        );

        sortedTopics.forEach(([topic, stats]) => {
          const partitionCount = stats.partitions.size;
          message += `  • ${topic}: ${formatNumber(stats.lag)} (${partitionCount} partition${partitionCount > 1 ? "s" : ""})\n`;
        });
      }

      // Add recommendations if lagging
      if (isLagging) {
        message += `\n⚠️  Recommendations:\n`;
        message += `  • Consumer group is lagging behind producers\n`;

        if (maxLag > totalLag * 0.8) {
          message += `  • Most lag is on a single partition - possible consumer bottleneck\n`;
        }

        message += `  • Consider scaling consumer instances\n`;
        message += `  • Review consumer processing time\n`;
      }

      logger.info(
        {
          clusterId,
          consumerGroupId,
          totalLag,
          maxLag,
          isLagging,
        },
        "Consumer lag checked successfully",
      );

      return this.createResponse(message, false, {
        clusterId,
        consumerGroupId,
        totalLag,
        maxLag,
        maxLagPartition: {
          topic: maxLagTopic,
          partition: maxLagPartition,
        },
        isLagging,
        warnThreshold,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error(
        { error, clusterId, consumerGroupId },
        "Error checking consumer lag",
      );

      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // Provide helpful error messages for common issues
      let userMessage = `Failed to check consumer lag for group '${consumerGroupId}' on cluster ${clusterId}: ${errorMessage}`;

      if (
        errorMessage.includes("401") ||
        errorMessage.includes("Unauthorized") ||
        errorMessage.includes("invalid API key")
      ) {
        userMessage += `\n\nAuthentication failed. Please verify:\n`;
        userMessage += `  • TELEMETRY_API_KEY (or CONFLUENT_CLOUD_API_KEY) is set correctly\n`;
        userMessage += `  • TELEMETRY_API_SECRET (or CONFLUENT_CLOUD_API_SECRET) is set correctly\n`;
        userMessage += `  • Using a Cloud API Key (not a Cluster API Key)\n`;
      } else if (errorMessage.includes("No lag data found")) {
        userMessage += `\n\nConsumer group may not exist or has no activity. Please verify:\n`;
        userMessage += `  • Consumer group ID is correct\n`;
        userMessage += `  • Consumer group has committed offsets in the last 5 minutes\n`;
        userMessage += `  • Consumers are actively consuming messages\n`;
      } else if (
        errorMessage.includes("403") ||
        errorMessage.includes("Forbidden")
      ) {
        userMessage += `\n\nPermission denied. Please verify:\n`;
        userMessage += `  • API key has permissions to access metrics\n`;
        userMessage += `  • Cloud API key has MetricsViewer role\n`;
      } else if (errorMessage.includes("TELEMETRY")) {
        userMessage += `\n\nTelemetry API not configured. Please set:\n`;
        userMessage += `  • TELEMETRY_API_KEY and TELEMETRY_API_SECRET\n`;
        userMessage += `  • Or CONFLUENT_CLOUD_API_KEY and CONFLUENT_CLOUD_API_SECRET\n`;
      }

      return this.createResponse(userMessage, true, {
        error: errorMessage,
        clusterId,
        consumerGroupId,
      });
    }
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.CHECK_CONSUMER_LAG,
      description:
        "Check consumer group lag for a specific consumer group on a Kafka cluster using Confluent Cloud Metrics API. Returns total lag, identifies max lag partition, and optionally provides per-topic lag breakdown. Warns when lag exceeds threshold. Uses lag data from the last 5 minutes.",
      inputSchema: checkConsumerLagArguments.shape,
    };
  }

  getRequiredEnvVars(): EnvVar[] {
    return ["TELEMETRY_API_KEY", "TELEMETRY_API_SECRET", "TELEMETRY_ENDPOINT"];
  }

  isConfluentCloudOnly(): boolean {
    return true;
  }
}
