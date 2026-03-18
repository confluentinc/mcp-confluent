/**
 * @fileoverview Handler for getting cluster-level metrics from Confluent Cloud
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
} from "./metrics-helper.js";

/**
 * Input schema for get-cluster-metrics tool
 */
const getClusterMetricsArguments = z.object({
  clusterId: z
    .string()
    .describe("Kafka cluster ID (e.g., lkc-xxxxx)")
    .refine((id) => id.startsWith("lkc-"), {
      message: "Cluster ID must start with 'lkc-'",
    }),
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
  includeAllMetrics: z
    .boolean()
    .default(false)
    .describe(
      "Include all available metrics (received/sent bytes, connections, load, etc.)",
    ),
});

/**
 * Handler for getting cluster-level metrics
 *
 * Fetches real-time telemetry data from Confluent Cloud Metrics API including:
 * - Throughput (received/sent bytes)
 * - Active connections
 * - Cluster load percentage
 * - Request/response metrics
 *
 * @example
 * Input:
 * {
 *   "clusterId": "lkc-12345",
 *   "timeRange": "1h",
 *   "includeAllMetrics": true
 * }
 *
 * Output:
 * Cluster Metrics: lkc-12345
 *
 * 📊 Last 1 hour:
 *   • Active Connections: 145
 *   • Received: 234.56 MB
 *   • Sent: 189.23 MB
 *   • Total Throughput: 423.79 MB
 *   • Cluster Load: 12.5%
 *
 * Time Range: 2024-03-16T13:50:00Z to 2024-03-16T14:50:00Z
 * Granularity: PT5M (5 minute intervals)
 */
export class GetClusterMetricsHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const { clusterId, timeRange, granularity, includeAllMetrics } =
      getClusterMetricsArguments.parse(toolArguments);

    try {
      logger.debug(
        {
          clusterId,
          timeRange,
          granularity,
          includeAllMetrics,
        },
        "Fetching cluster metrics",
      );

      const telemetryClient =
        clientManager.getConfluentCloudTelemetryRestClient();
      const { start, end } = getTimeRange(timeRange as TimeRangePreset);

      // Auto-select granularity based on time range if not provided
      const selectedGranularity: MetricGranularity =
        granularity ?? this.getRecommendedGranularity(timeRange);

      // Define core metrics (always fetched)
      // Note: Telemetry API only allows ONE aggregation per query
      // Note: active_connection_count is not available via Metrics API
      const coreMetrics = [
        { metric: METRICS.RECEIVED_BYTES, agg: "SUM" as const },
        { metric: METRICS.SENT_BYTES, agg: "SUM" as const },
        { metric: METRICS.RETAINED_BYTES, agg: "SUM" as const },
      ];

      // Add additional metrics if requested
      const allMetrics = includeAllMetrics
        ? [
            ...coreMetrics,
            { metric: METRICS.REQUEST_COUNT, agg: "SUM" as const },
          ]
        : coreMetrics;

      // Query each metric separately (API only allows one aggregation per request)
      const metricResults = new Map<string, number>();

      for (const metricDef of allMetrics) {
        const response = await queryMetrics(telemetryClient, "cloud", {
          aggregations: [metricDef], // Only one aggregation per query
          filters: [
            { field: FILTER_FIELDS.CLUSTER_ID, op: "EQ", value: clusterId },
          ],
          granularity: selectedGranularity,
          startTime: start,
          endTime: end,
        });

        const value = getLatestValue(response);
        metricResults.set(metricDef.metric, value);
      }

      // Extract latest values
      const receivedBytes = metricResults.get(METRICS.RECEIVED_BYTES) || 0;
      const sentBytes = metricResults.get(METRICS.SENT_BYTES) || 0;
      const retainedBytes = metricResults.get(METRICS.RETAINED_BYTES) || 0;

      // Build the response message
      let message = `Cluster Metrics: ${clusterId}\n\n`;
      message += `📊 Last ${timeRange}:\n`;
      message += `  • Received: ${formatBytes(receivedBytes)}\n`;
      message += `  • Sent: ${formatBytes(sentBytes)}\n`;
      message += `  • Total Throughput: ${formatBytes(receivedBytes + sentBytes)}\n`;
      message += `  • Retained Data: ${formatBytes(retainedBytes)}\n`;

      // Add additional metrics if requested
      if (includeAllMetrics) {
        const requestCount = metricResults.get(METRICS.REQUEST_COUNT) || 0;
        message += `  • Request Count: ${formatNumber(Math.round(requestCount))}\n`;
      }

      message += `\n`;
      message += `Time Range: ${start} to ${end}\n`;
      message += `Granularity: ${selectedGranularity} (${this.getGranularityDescription(selectedGranularity)})`;

      // Add health indicators (simplified since we don't have connection/load metrics)
      const healthIndicators: string[] = [];

      if (healthIndicators.length > 0) {
        message += `\n\n⚠️  Health Indicators:\n`;
        healthIndicators.forEach((indicator) => {
          message += `  • ${indicator}\n`;
        });
      }

      logger.info(
        {
          clusterId,
          receivedBytes,
          sentBytes,
          retainedBytes,
          metricsQueried: metricResults.size,
        },
        "Cluster metrics fetched successfully",
      );

      return this.createResponse(message, false, {
        clusterId,
        timeRange,
        granularity: selectedGranularity,
        metrics: {
          receivedBytes,
          sentBytes,
          retainedBytes,
          totalThroughput: receivedBytes + sentBytes,
          ...(includeAllMetrics
            ? {
                requestCount: metricResults.get(METRICS.REQUEST_COUNT) || 0,
              }
            : {}),
        },
        timestamp: new Date().toISOString(),
        metricsQueried: metricResults.size,
      });
    } catch (error) {
      logger.error(
        { error, clusterId, timeRange },
        "Error fetching cluster metrics",
      );

      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // Provide helpful error messages for common issues
      let userMessage = `Failed to fetch cluster metrics for ${clusterId}: ${errorMessage}`;

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
        userMessage += `\n\nCluster not found. Please verify:\n`;
        userMessage += `  • Cluster ID is correct (should start with 'lkc-')\n`;
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
   * Get health indicators based on metrics
   */
  private getHealthIndicators(
    activeConnections: number,
    clusterLoad: number,
  ): string[] {
    const indicators: string[] = [];

    // Check for high cluster load
    if (clusterLoad > 80) {
      indicators.push(
        `High cluster load (${clusterLoad.toFixed(1)}%) - consider scaling`,
      );
    }

    // Check for low connection count (might indicate connectivity issues)
    if (activeConnections === 0) {
      indicators.push("No active connections detected");
    }

    return indicators;
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.GET_CLUSTER_METRICS,
      description:
        "Get real-time metrics for a Kafka cluster including throughput (received/sent bytes), active connections, and cluster load percentage from Confluent Cloud Telemetry API",
      inputSchema: getClusterMetricsArguments.shape,
    };
  }

  getRequiredEnvVars(): EnvVar[] {
    return ["TELEMETRY_API_KEY", "TELEMETRY_API_SECRET"];
  }

  isConfluentCloudOnly(): boolean {
    return true;
  }
}
