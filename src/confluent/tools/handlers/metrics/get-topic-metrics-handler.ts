import { z } from "zod";
import { MetricHandler } from "./metric-handler.js";
import { ToolConfig } from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ClientManager } from "@src/confluent/client-manager.js";
import { CallToolResult } from "@src/confluent/schema.js";

const getTopicMetricsArguments = z.object({
  clusterId: z
    .string()
    .describe("The Kafka cluster ID (e.g., lkc-xxxxxx)")
    .default(process.env.KAFKA_CLUSTER_ID || ""),
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
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const args = this.getSchema().parse(toolArguments) as Record<
      string,
      unknown
    >;
    if (args["specificMetric"]) {
      args["metrics"] = [args["specificMetric"] as string];
    }
    let intervalStart = args["intervalStart"] as string | undefined;
    let intervalEnd = args["intervalEnd"] as string | undefined;
    if (!intervalStart || !intervalEnd) {
      const defaultIntervals = this.getDefaultIntervals();
      intervalStart = intervalStart || defaultIntervals.intervalStart;
      intervalEnd = intervalEnd || defaultIntervals.intervalEnd;
    }
    const topicName = args["topicName"] as string | undefined;
    const aggregationType = args["aggregationType"] as string | undefined;
    const limit = args["limit"] as number | undefined;
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
      args,
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
