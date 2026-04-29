import { ClientManager } from "@src/confluent/client-manager.js";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  READ_ONLY,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import {
  connectionIdsWhere,
  hasTelemetry,
} from "@src/confluent/tools/connection-predicates.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import env from "@src/env.js";
import { logger } from "@src/logger.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { z } from "zod";

const queryMetricsArguments = z.object({
  metric: z
    .string()
    .describe(
      'The metric name to query. Common Kafka metrics: "io.confluent.kafka.server/received_bytes", "io.confluent.kafka.server/sent_bytes", "io.confluent.kafka.server/received_records", "io.confluent.kafka.server/sent_records", "io.confluent.kafka.server/retained_bytes", "io.confluent.kafka.server/consumer_lag_offsets", "io.confluent.kafka.server/request_count". Common Flink metrics: "io.confluent.flink/num_records_in", "io.confluent.flink/num_records_out". Common Connector metrics: "io.confluent.kafka.connect/sent_records", "io.confluent.kafka.connect/received_records".',
    ),
  dataset: z
    .enum(["cloud"])
    .default("cloud")
    .describe("The metrics dataset to query.")
    .optional(),
  aggregation: z
    .enum(["SUM", "MAX", "AVG", "MIN", "COUNT"])
    .default("SUM")
    .describe("Aggregation function to apply to the metric values.")
    .optional(),
  filter: z
    .record(z.string(), z.string())
    .describe(
      'Key-value pairs to filter results. Use "resource.kafka.id" for cluster ID (e.g. "lkc-abc123"), "metric.topic" for topic name (e.g. "sensor-readings"), "metric.consumer_group_id" for consumer group, "resource.connector.id" for connector ID, "resource.environment.id" for environment ID, "resource.schema_registry.id" for schema registry ID. For Kafka topic metrics, "resource.kafka.id" is required.',
    )
    .optional(),
  granularity: z
    .enum(["PT1M", "PT5M", "PT15M", "PT30M", "PT1H", "P1D", "ALL"])
    .default("PT1M")
    .describe(
      "Time granularity for the metric data points. Defaults to PT1M. Use PT1M or PT5M for intervals under a few hours, PT1H for day-scale queries, P1D for multi-day queries.",
    )
    .optional(),
  interval: z
    .string()
    .describe(
      'Time range as two ISO 8601 timestamps separated by "/". Example: "2024-01-01T00:00:00Z/2024-01-02T00:00:00Z". Must include both start and end timestamps. Defaults to the last 1 hour if omitted. Do NOT pass a duration like "PT1H" — always use "start/end" format.',
    )
    .optional(),
  group_by: z
    .array(z.string())
    .describe(
      'Label keys to group results by. Common keys: "resource.kafka.id" (by cluster), "metric.topic" (by topic), "metric.partition" (by partition), "metric.consumer_group_id" (by consumer group), "metric.type" (by request type). Returns separate time series for each group.',
    )
    .optional(),
  limit: z
    .number()
    .int()
    .positive()
    .max(1000)
    .default(100)
    .describe("Maximum number of data points to return (max 1000).")
    .optional(),
});

// Response format from the Telemetry API (flat or grouped)
interface TelemetryResponse {
  data?: Array<Record<string, unknown>>;
  errors?: Array<{ detail?: string }>;
}

export class QueryMetricsHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const args = queryMetricsArguments.parse(toolArguments);
    const {
      metric,
      dataset = "cloud",
      aggregation = "SUM",
      filter,
      granularity = "PT1M",
      group_by,
      limit = 100,
    } = args;

    // Resolve interval to a proper "start/end" range
    let interval = args.interval;
    if (!interval || !interval.includes("/")) {
      // No interval provided, or a duration like "PT1H" was passed instead of a range
      const now = new Date();
      const durationMs = parseDuration(interval) ?? 60 * 60 * 1000; // default 1 hour
      const start = new Date(now.getTime() - durationMs);
      interval = `${start.toISOString()}/${now.toISOString()}`;
    }

    try {
      const telemetryClient =
        clientManager.getConfluentCloudTelemetryRestClient();

      // Auto-inject resource.kafka.id for Kafka metrics if not provided
      const effectiveFilter = { ...filter };
      if (
        metric.startsWith("io.confluent.kafka.server/") &&
        !effectiveFilter["resource.kafka.id"] &&
        env.KAFKA_CLUSTER_ID
      ) {
        effectiveFilter["resource.kafka.id"] = env.KAFKA_CLUSTER_ID;
      }

      // Build filter object
      const filters = Object.entries(effectiveFilter).map(([field, value]) => ({
        field,
        op: "EQ" as const,
        value,
      }));

      const filterObj =
        filters.length > 0
          ? filters.length === 1
            ? filters[0]
            : { op: "AND" as const, filters }
          : undefined;

      logger.debug(
        { metric, filter: effectiveFilter, granularity, interval },
        "Querying metrics",
      );

      // Build request body
      const useGrouped = group_by && group_by.length > 0;
      const body: Record<string, unknown> = {
        aggregations: [{ metric, agg: aggregation }],
        granularity,
        intervals: [interval],
        limit,
      };

      if (filterObj) {
        body.filter = filterObj;
      }

      if (useGrouped) {
        body.group_by = group_by;
        body.format = "GROUPED";
      }

      const response = (await telemetryClient.POST(
        "/v2/metrics/{dataset}/query" as never,
        {
          params: { path: { dataset } },
          body,
        } as never,
      )) as { data?: TelemetryResponse; error?: unknown };

      const data = response.data as TelemetryResponse;

      if (data?.errors && data.errors.length > 0) {
        const errorDetails = data.errors
          .map((e) => e.detail)
          .filter(Boolean)
          .join("; ");
        return this.createResponse(
          `Metrics query returned errors: ${errorDetails}`,
          true,
        );
      }

      if (!data?.data || data.data.length === 0) {
        return this.createResponse(
          `No data returned for metric "${metric}" in the specified interval.\n\nQuery details:\n  Metric: ${metric}\n  Dataset: ${dataset}\n  Aggregation: ${aggregation}\n  Granularity: ${granularity}\n  Interval: ${interval}\n  Filter: ${JSON.stringify(effectiveFilter)}${group_by ? `\n  Group by: ${group_by.join(", ")}` : ""}`,
        );
      }

      // Format the response
      const output = formatMetricsResponse(
        data.data,
        metric,
        aggregation,
        granularity,
        interval,
        effectiveFilter,
        group_by,
      );

      return this.createResponse(output, false, {
        metric,
        dataset,
        aggregation,
        granularity,
        interval,
        result_count: data.data.length,
      });
    } catch (error) {
      logger.error({ error }, "Error in QueryMetricsHandler");
      return this.createResponse(
        `Failed to query metrics: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.QUERY_METRICS,
      description:
        "Query Confluent Cloud metrics from the Telemetry API. IMPORTANT: Use the list-available-metrics tool first to discover valid metric names and filter fields — do not guess them. Supports Kafka, Flink, Connectors, and Schema Registry metrics with flexible filtering, aggregation, and grouping.",
      inputSchema: queryMetricsArguments.shape,
      annotations: READ_ONLY,
    };
  }

  enabledConnectionIds(runtime: ServerRuntime): string[] {
    return connectionIdsWhere(runtime.config.connections, hasTelemetry);
  }

  isConfluentCloudOnly(): boolean {
    return true;
  }
}

function formatMetricsResponse(
  data: Array<Record<string, unknown>>,
  metric: string,
  aggregation: string,
  granularity: string,
  interval: string,
  filter?: Record<string, string>,
  groupBy?: string[],
): string {
  const lines: string[] = [];

  lines.push(`Metrics Query Results`);
  lines.push(`  Metric: ${metric}`);
  lines.push(`  Aggregation: ${aggregation}`);
  lines.push(`  Granularity: ${granularity}`);
  lines.push(`  Interval: ${interval}`);
  if (filter && Object.keys(filter).length > 0) {
    lines.push(`  Filter: ${JSON.stringify(filter)}`);
  }
  if (groupBy && groupBy.length > 0) {
    lines.push(`  Group by: ${groupBy.join(", ")}`);
  }
  lines.push("");

  // Detect format: flat responses have timestamp/value at top level,
  // grouped responses have a points array
  const firstItem = data[0];
  const isFlat =
    firstItem !== undefined && "timestamp" in firstItem && "value" in firstItem;

  if (isFlat) {
    lines.push(`Data Points: ${data.length}`);
    for (const point of data) {
      const ts = point.timestamp
        ? new Date(point.timestamp as string).toISOString()
        : "unknown";
      const val =
        point.value !== undefined ? formatValue(point.value as number) : "N/A";
      lines.push(`  ${ts}: ${val}`);
    }
  } else {
    lines.push(`Groups: ${data.length}`);
    lines.push("");
    for (const group of data) {
      const labels: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(group)) {
        if (key !== "points") {
          labels[key] = value;
        }
      }

      if (Object.keys(labels).length > 0) {
        const labelStr = Object.entries(labels)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ");
        lines.push(`Group: ${labelStr}`);
      }

      const points = group.points as
        | Array<{ timestamp?: string; value?: number }>
        | undefined;
      if (points && points.length > 0) {
        for (const point of points) {
          const ts = point.timestamp
            ? new Date(point.timestamp).toISOString()
            : "unknown";
          const val =
            point.value !== undefined ? formatValue(point.value) : "N/A";
          lines.push(`  ${ts}: ${val}`);
        }
      } else {
        lines.push("  (no data points)");
      }
      lines.push("");
    }
  }

  return lines.join("\n").trimEnd();
}

function formatValue(value: number): string {
  if (Number.isInteger(value)) {
    return value.toLocaleString();
  }
  return value.toFixed(4);
}

/**
 * Parse an ISO 8601 duration string (e.g. "PT1H", "PT30M", "P1D") to milliseconds.
 * Returns undefined if the string is not a recognized duration.
 */
function parseDuration(duration: string | undefined): number | undefined {
  if (!duration) return undefined;
  const match = duration.match(
    /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/,
  );
  if (!match) return undefined;
  const days = parseInt(match[1] || "0", 10);
  const hours = parseInt(match[2] || "0", 10);
  const minutes = parseInt(match[3] || "0", 10);
  const seconds = parseInt(match[4] || "0", 10);
  return ((days * 24 + hours) * 60 + minutes) * 60 * 1000 + seconds * 1000;
}
