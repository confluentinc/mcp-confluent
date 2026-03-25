/**
 * @fileoverview Handler for getting topic-level metrics from Confluent Cloud
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
  queryMetrics,
  METRICS,
  FILTER_FIELDS,
  getTimeRange,
  formatBytes,
  formatNumber,
  getLatestValue,
  type MetricGranularity,
  type TimeRangePreset,
  type MetricDataPoint,
  groupMetricsBy,
} from "./metrics-helper.js";

/**
 * Input schema for get-topic-metrics tool
 */
const getTopicMetricsArguments = z.object({
  clusterId: z
    .string()
    .describe("Kafka cluster ID (e.g., lkc-xxxxx)")
    .refine((id) => id.startsWith("lkc-"), {
      message: "Cluster ID must start with 'lkc-'",
    }),
  topicName: z.string().describe("Topic name to get metrics for"),
  timeRange: z
    .enum(["5m", "15m", "1h", "6h", "24h", "7d"])
    .default("1h")
    .describe("Time range for metrics query (default: 1h)"),
  granularity: z
    .enum(["PT1M", "PT5M", "PT15M", "PT1H", "P1D"])
    .optional()
    .describe(
      "Time granularity for aggregation (default: auto-selected based on time range)",
    ),
  includePartitionBreakdown: z
    .boolean()
    .default(false)
    .describe("Include per-partition metrics breakdown"),
});

/**
 * Handler for getting topic-level metrics
 *
 * Fetches real-time telemetry data from Confluent Cloud Metrics API including:
 * - Throughput (received/sent bytes and records)
 * - Retained bytes
 * - Optionally per-partition breakdown
 *
 * @example
 * Input:
 * {
 *   "clusterId": "lkc-12345",
 *   "topicName": "orders",
 *   "timeRange": "1h",
 *   "includePartitionBreakdown": true
 * }
 *
 * Output:
 * Topic Metrics: orders (lkc-12345)
 *
 * 📊 Last 1 hour:
 *   • Received: 234.56 MB (1,234,567 records)
 *   • Sent: 189.23 MB (987,654 records)
 *   • Retained: 1.23 GB
 *   • Total Throughput: 423.79 MB
 *
 * Per-Partition Breakdown:
 *   • Partition 0: 100.45 MB received, 85.23 MB sent
 *   • Partition 1: 134.11 MB received, 104.00 MB sent
 *
 * Time Range: 2024-03-16T13:50:00Z to 2024-03-16T14:50:00Z
 * Granularity: PT5M (5 minute intervals)
 */
export class GetTopicMetricsHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const {
      clusterId,
      topicName,
      timeRange,
      granularity,
      includePartitionBreakdown,
    } = getTopicMetricsArguments.parse(toolArguments);

    try {
      logger.debug(
        {
          clusterId,
          topicName,
          timeRange,
          granularity,
          includePartitionBreakdown,
        },
        "Fetching topic metrics",
      );

      const telemetryClient =
        clientManager.getConfluentCloudTelemetryRestClient();
      const { start, end } = getTimeRange(timeRange as TimeRangePreset);

      // Auto-select granularity based on time range if not provided
      const selectedGranularity: MetricGranularity =
        granularity ?? this.getRecommendedGranularity(timeRange);

      // Define topic metrics (API only allows ONE aggregation per query)
      const topicMetrics = [
        { metric: METRICS.RECEIVED_BYTES, agg: "SUM" as const },
        { metric: METRICS.SENT_BYTES, agg: "SUM" as const },
        { metric: METRICS.RETAINED_BYTES, agg: "SUM" as const },
        { metric: METRICS.RECEIVED_RECORDS, agg: "SUM" as const },
        { metric: METRICS.SENT_RECORDS, agg: "SUM" as const },
      ];

      // Base filters for topic
      const baseFilters = [
        {
          field: FILTER_FIELDS.CLUSTER_ID,
          op: "EQ" as const,
          value: clusterId,
        },
        { field: FILTER_FIELDS.TOPIC, op: "EQ" as const, value: topicName },
      ];

      // Group by partition if requested
      const groupBy = includePartitionBreakdown
        ? [FILTER_FIELDS.PARTITION]
        : [];

      // Query each metric separately (API only allows one aggregation per request)
      const metricResults = new Map<string, number>();
      const partitionMetrics = new Map<
        string,
        Map<string, MetricDataPoint[]>
      >();

      for (const metricDef of topicMetrics) {
        const response = await queryMetrics(telemetryClient, "cloud", {
          aggregations: [metricDef], // Only one aggregation per query
          filters: baseFilters,
          granularity: selectedGranularity,
          startTime: start,
          endTime: end,
          groupBy,
        });

        if (includePartitionBreakdown && response.data) {
          // Store per-partition data
          const partitionGroups = groupMetricsBy(
            response.data as MetricDataPoint[],
            FILTER_FIELDS.PARTITION,
          );
          partitionMetrics.set(metricDef.metric, partitionGroups);

          // Calculate total across all partitions
          let total = 0;
          for (const points of partitionGroups.values()) {
            const latestPoint = points[points.length - 1];
            if (latestPoint && typeof latestPoint.value === "number") {
              total += latestPoint.value;
            }
          }
          metricResults.set(metricDef.metric, total);
        } else {
          // Get the latest value for the whole topic
          const value = getLatestValue(response);
          metricResults.set(metricDef.metric, value);
        }
      }

      // Extract latest values
      const receivedBytes = metricResults.get(METRICS.RECEIVED_BYTES) || 0;
      const sentBytes = metricResults.get(METRICS.SENT_BYTES) || 0;
      const retainedBytes = metricResults.get(METRICS.RETAINED_BYTES) || 0;
      const receivedRecords = metricResults.get(METRICS.RECEIVED_RECORDS) || 0;
      const sentRecords = metricResults.get(METRICS.SENT_RECORDS) || 0;

      // Build the response message
      let message = `Topic Metrics: ${topicName} (${clusterId})\n\n`;
      message += `📊 Last ${timeRange}:\n`;
      message += `  • Received: ${formatBytes(receivedBytes)} (${formatNumber(Math.round(receivedRecords))} records)\n`;
      message += `  • Sent: ${formatBytes(sentBytes)} (${formatNumber(Math.round(sentRecords))} records)\n`;
      message += `  • Retained: ${formatBytes(retainedBytes)}\n`;
      message += `  • Total Throughput: ${formatBytes(receivedBytes + sentBytes)}\n`;

      // Add per-partition breakdown if requested
      if (includePartitionBreakdown && partitionMetrics.size > 0) {
        message += `\nPer-Partition Breakdown:\n`;

        // Get all partition numbers
        const receivedBytesPartitions =
          partitionMetrics.get(METRICS.RECEIVED_BYTES) || new Map();
        const sentBytesPartitions =
          partitionMetrics.get(METRICS.SENT_BYTES) || new Map();

        const allPartitions = new Set([
          ...receivedBytesPartitions.keys(),
          ...sentBytesPartitions.keys(),
        ]);

        const sortedPartitions = Array.from(allPartitions).sort((a, b) => {
          const numA = parseInt(a, 10);
          const numB = parseInt(b, 10);
          return numA - numB;
        });

        for (const partition of sortedPartitions) {
          const receivedPoints = receivedBytesPartitions.get(partition) || [];
          const sentPoints = sentBytesPartitions.get(partition) || [];

          const receivedLatest = receivedPoints[receivedPoints.length - 1];
          const sentLatest = sentPoints[sentPoints.length - 1];

          const receivedValue =
            receivedLatest && typeof receivedLatest.value === "number"
              ? receivedLatest.value
              : 0;
          const sentValue =
            sentLatest && typeof sentLatest.value === "number"
              ? sentLatest.value
              : 0;

          message += `  • Partition ${partition}: ${formatBytes(receivedValue)} received, ${formatBytes(sentValue)} sent\n`;
        }
      }

      message += `\n`;
      message += `Time Range: ${start} to ${end}\n`;
      message += `Granularity: ${selectedGranularity} (${this.getGranularityDescription(selectedGranularity)})`;

      // Add health indicators
      const healthIndicators = this.getHealthIndicators(
        receivedBytes,
        sentBytes,
        retainedBytes,
      );

      if (healthIndicators.length > 0) {
        message += `\n\n⚠️  Health Indicators:\n`;
        healthIndicators.forEach((indicator) => {
          message += `  • ${indicator}\n`;
        });
      }

      logger.info(
        {
          clusterId,
          topicName,
          receivedBytes,
          sentBytes,
          retainedBytes,
          receivedRecords,
          sentRecords,
          metricsQueried: metricResults.size,
        },
        "Topic metrics fetched successfully",
      );

      return this.createResponse(message, false, {
        clusterId,
        topicName,
        timeRange,
        granularity: selectedGranularity,
        metrics: {
          receivedBytes,
          sentBytes,
          retainedBytes,
          receivedRecords,
          sentRecords,
          totalThroughput: receivedBytes + sentBytes,
        },
        timestamp: new Date().toISOString(),
        metricsQueried: metricResults.size,
      });
    } catch (error) {
      logger.error(
        { error, clusterId, topicName, timeRange },
        "Error fetching topic metrics",
      );

      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // Provide helpful error messages for common issues
      let userMessage = `Failed to fetch metrics for topic '${topicName}' on cluster ${clusterId}: ${errorMessage}`;

      if (
        errorMessage.includes("401") ||
        errorMessage.includes("Unauthorized")
      ) {
        userMessage += `\n\nAuthentication failed. Please verify:\n`;
        userMessage += `  • TELEMETRY_API_KEY is set correctly\n`;
        userMessage += `  • TELEMETRY_API_SECRET is set correctly\n`;
        userMessage += `  • API key has MetricsViewer role\n`;
      } else if (
        errorMessage.includes("404") ||
        errorMessage.includes("Not Found")
      ) {
        userMessage += `\n\nTopic or cluster not found. Please verify:\n`;
        userMessage += `  • Topic name is correct\n`;
        userMessage += `  • Cluster ID is correct (should start with 'lkc-')\n`;
        userMessage += `  • Topic exists on this cluster\n`;
        userMessage += `  • You have access to this cluster\n`;
      } else if (
        errorMessage.includes("429") ||
        errorMessage.includes("rate limit")
      ) {
        userMessage += `\n\nRate limit exceeded. Please:\n`;
        userMessage += `  • Wait a few minutes before retrying\n`;
        userMessage += `  • Consider using a longer time range or larger granularity\n`;
      }

      return this.createResponse(userMessage, true, {
        error: errorMessage,
        clusterId,
        topicName,
        timeRange,
      });
    }
  }

  /**
   * Get recommended granularity based on time range
   */
  private getRecommendedGranularity(timeRange: string): MetricGranularity {
    const granularityMap: Record<string, MetricGranularity> = {
      "5m": "PT1M",
      "15m": "PT1M",
      "1h": "PT5M",
      "6h": "PT5M",
      "24h": "PT15M",
      "7d": "PT1H",
    };

    return granularityMap[timeRange] || "PT5M";
  }

  /**
   * Get human-readable granularity description
   */
  private getGranularityDescription(granularity: MetricGranularity): string {
    const descriptions: Record<MetricGranularity, string> = {
      PT1M: "1 minute intervals",
      PT5M: "5 minute intervals",
      PT15M: "15 minute intervals",
      PT1H: "1 hour intervals",
      P1D: "1 day intervals",
    };

    return descriptions[granularity] || granularity;
  }

  /**
   * Get health indicators based on topic metrics
   */
  private getHealthIndicators(
    receivedBytes: number,
    sentBytes: number,
    retainedBytes: number,
  ): string[] {
    const indicators: string[] = [];

    // Check for no activity
    if (receivedBytes === 0 && sentBytes === 0) {
      indicators.push("No activity detected in the selected time range");
    }

    // Check for imbalanced traffic (more sent than received)
    if (sentBytes > receivedBytes * 2 && receivedBytes > 0) {
      indicators.push(
        "High consumer activity - sent bytes significantly exceed received bytes",
      );
    }

    // Check for very large retention (>10GB per topic might be worth investigating)
    const tenGB = 10 * 1024 * 1024 * 1024;
    if (retainedBytes > tenGB) {
      indicators.push(
        `Large data retention (${formatBytes(retainedBytes)}) - consider reviewing retention policy`,
      );
    }

    return indicators;
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.GET_TOPIC_METRICS,
      description:
        "Get real-time metrics for a specific Kafka topic including throughput (received/sent bytes and records), retained bytes, and optionally per-partition breakdown from Confluent Cloud Telemetry API",
      inputSchema: getTopicMetricsArguments.shape,
    };
  }

  getRequiredEnvVars(): EnvVar[] {
    return ["TELEMETRY_API_KEY", "TELEMETRY_API_SECRET"];
  }

  isConfluentCloudOnly(): boolean {
    return true;
  }
}
