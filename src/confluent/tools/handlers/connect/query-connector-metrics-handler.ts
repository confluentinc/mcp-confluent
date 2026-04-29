import { ClientManager } from "@src/confluent/client-manager.js";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  READ_ONLY,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { QueryMetricsHandler } from "@src/confluent/tools/handlers/metrics/query-metrics-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { EnvVar, TELEMETRY_REQUIRED_ENV_VARS } from "@src/env-schema.js";
import { z } from "zod";

const queryConnectorMetricsArguments = z.object({
  connectorId: z
    .string()
    .describe("Confluent Cloud connector resource ID, e.g. 'lcc-abc123'."),
  metric: z
    .string()
    .describe(
      'The connector metric name to query. Common Connector metrics: "io.confluent.kafka.connect/sent_records", "io.confluent.kafka.connect/received_records", "io.confluent.kafka.connect/dead_letter_queue_records". Use list-connector-metrics first to discover valid metric names.',
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
      'Additional key-value pairs to filter results. The "resource.connector.id" filter is auto-injected from connectorId; pass additional filters here as needed (e.g. "resource.environment.id").',
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
      "Label keys to group results by. Returns separate time series for each group.",
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

export class QueryConnectorMetricsHandler extends BaseToolHandler {
  private inner = new QueryMetricsHandler();

  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const { connectorId, filter, ...rest } =
      queryConnectorMetricsArguments.parse(toolArguments);

    const mergedFilter: Record<string, string> = {
      ...(filter ?? {}),
      "resource.connector.id": connectorId,
    };

    return this.inner.handle(clientManager, {
      ...rest,
      filter: mergedFilter,
    });
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.QUERY_CONNECTOR_METRICS,
      description:
        "Query metrics for a specific connector from the Telemetry API. Auto-injects resource.connector.id filter; pass other filters/group_by as needed. Use list-connector-metrics first to discover valid metric names.",
      inputSchema: queryConnectorMetricsArguments.shape,
      annotations: READ_ONLY,
    };
  }

  getRequiredEnvVars(): readonly EnvVar[] {
    return TELEMETRY_REQUIRED_ENV_VARS;
  }

  isConfluentCloudOnly(): boolean {
    return true;
  }
}
