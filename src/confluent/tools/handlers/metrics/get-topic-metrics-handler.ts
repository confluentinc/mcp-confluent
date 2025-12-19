import { z } from "zod";
import { MetricHandler } from "@src/confluent/tools/handlers/metrics/metric-handler.js";
import { ToolConfig } from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ClientManager } from "@src/confluent/client-manager.js";
import { CallToolResult } from "@src/confluent/schema.js";
import { EnvVar } from "@src/env-schema.js";
import env from "@src/env.js";

const getTopicMetricsArguments = z.object({
  clusterId: z
    .string()
    .describe("The Kafka cluster ID (e.g., lkc-xxxxxx)")
    .default(() => env.KAFKA_CLUSTER_ID || ""),
  topicName: z.string().optional(), // Make topicName optional for filtering
  metrics: z
    .array(z.string())
    .default([
      "io.confluent.kafka.server/sent_records",
      "io.confluent.kafka.server/received_records",
      "io.confluent.kafka.server/sent_bytes",
      "io.confluent.kafka.server/received_bytes",
      "io.confluent.kafka.server/retained_bytes",
      "io.confluent.kafka.server/consumer_lag_offsets",
    ]),
  intervalStart: z.string().optional(),
  intervalEnd: z.string().optional(),
  limit: z.number().optional(),
  aggregationType: z.enum(["SUM", "MIN", "MAX"]).optional(),
  specificMetric: z
    .string()
    .optional()
    .describe("If provided, only this specific metric will be queried"),
  includeRelatedMetrics: z
    .boolean()
    .optional()
    .describe(
      "If true, include related metrics information from the metrics descriptor API",
    ),
});

export class GetTopicMetricsHandler extends MetricHandler {
  getGroupBy() {
    return "metric.topic";
  }
  getFilterField() {
    return "resource.kafka.id";
  }
  getFilterValue(args: unknown) {
    return (args as { clusterId: string }).clusterId;
  }
  getSchema() {
    return getTopicMetricsArguments;
  }

  getRequiredEnvVars(): EnvVar[] {
    return [
      "CONFLUENT_CLOUD_API_KEY",
      "CONFLUENT_CLOUD_API_SECRET",
      "CONFLUENT_CLOUD_TELEMETRY_ENDPOINT",
    ];
  }

  isConfluentCloudOnly(): boolean {
    return true;
  }

  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const args = this.getSchema().parse(toolArguments);

    // Override metrics if specificMetric is provided
    const metrics = args.specificMetric ? [args.specificMetric] : args.metrics;

    // Use default intervals if not provided
    let intervalStart = args.intervalStart;
    let intervalEnd = args.intervalEnd;
    if (!intervalStart || !intervalEnd) {
      const defaultIntervals = this.getDefaultIntervals();
      intervalStart = intervalStart || defaultIntervals.intervalStart;
      intervalEnd = intervalEnd || defaultIntervals.intervalEnd;
    }

    const { topicName, aggregationType, limit } = args;
    const postFilter = topicName
      ? (data: unknown) =>
          typeof data === "object" && data !== null
            ? {
                ...data,
                data: Array.isArray((data as { data?: unknown }).data)
                  ? ((data as { data?: unknown }).data as unknown[]).filter(
                      (row: unknown) =>
                        typeof row === "object" &&
                        row !== null &&
                        "metric.topic" in row &&
                        (row as Record<string, unknown>)["metric.topic"] ===
                          topicName,
                    )
                  : [],
              }
            : data
      : undefined;
    return this.handleMetricsWithFilter(
      clientManager,
      { ...args, metrics },
      aggregationType,
      limit,
      intervalStart,
      intervalEnd,
      postFilter,
    );
  }
  getToolConfig(): ToolConfig {
    return {
      name: ToolName.GET_TOPIC_METRICS,
      description:
        "Get metrics for Kafka topics with group_by topic. Specify topicName to filter results for a specific topic. Optionally provide a specificMetric or aggregation type (SUM, MIN, MAX). Set includeRelatedMetrics=true to get additional metadata about the metrics.",
      inputSchema: getTopicMetricsArguments.shape,
    };
  }
}
