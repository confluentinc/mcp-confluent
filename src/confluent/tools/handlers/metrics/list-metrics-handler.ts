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
import { logger } from "@src/logger.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { z } from "zod";

const listMetricsArguments = z.object({
  resource_type: z
    .enum([
      "kafka",
      "connector",
      "compute_pool",
      "flink_statement",
      "schema_registry",
      "ksql",
    ])
    .describe(
      'Filter metrics by resource type. Use "kafka" for Kafka cluster/topic metrics, "connector" for Kafka Connect metrics, "compute_pool" for Flink compute pool metrics, "flink_statement" for Flink statement metrics.',
    )
    .optional(),
});

interface MetricDescriptor {
  name: string;
  description: string;
  type: string;
  unit: string;
  lifecycle_stage: string;
  resources: string[];
  labels: Array<{ key: string; description: string }>;
}

interface ResourceDescriptor {
  type: string;
  description: string;
  labels: Array<{ key: string; description: string }>;
}

interface DescriptorResponse {
  data?: MetricDescriptor[] | ResourceDescriptor[];
  errors?: Array<{ detail?: string }>;
}

/**
 * Well-known Kafka server metrics that may not appear in the descriptors
 * endpoint but are queryable via the Telemetry API.
 */
const KAFKA_SERVER_METRICS = [
  {
    name: "io.confluent.kafka.server/received_bytes",
    description: "Total bytes received by the cluster from producers",
    unit: "By",
    labels: [
      { key: "topic", description: "Kafka topic name" },
      { key: "partition", description: "Partition ID" },
    ],
  },
  {
    name: "io.confluent.kafka.server/sent_bytes",
    description: "Total bytes sent by the cluster to consumers",
    unit: "By",
    labels: [
      { key: "topic", description: "Kafka topic name" },
      { key: "partition", description: "Partition ID" },
    ],
  },
  {
    name: "io.confluent.kafka.server/received_records",
    description: "Total records received by the cluster from producers",
    unit: "1",
    labels: [{ key: "topic", description: "Kafka topic name" }],
  },
  {
    name: "io.confluent.kafka.server/sent_records",
    description: "Total records sent by the cluster to consumers",
    unit: "1",
    labels: [{ key: "topic", description: "Kafka topic name" }],
  },
  {
    name: "io.confluent.kafka.server/retained_bytes",
    description: "Total bytes retained (stored) by the cluster",
    unit: "By",
    labels: [
      { key: "topic", description: "Kafka topic name" },
      { key: "partition", description: "Partition ID" },
    ],
  },
  {
    name: "io.confluent.kafka.server/consumer_lag_offsets",
    description: "Consumer lag in number of offsets for a consumer group",
    unit: "1",
    labels: [
      { key: "topic", description: "Kafka topic name" },
      { key: "consumer_group_id", description: "Consumer group ID" },
      { key: "partition", description: "Partition ID" },
    ],
  },
  {
    name: "io.confluent.kafka.server/request_count",
    description: "Total number of requests to the cluster",
    unit: "1",
    labels: [{ key: "type", description: "Request type" }],
  },
  {
    name: "io.confluent.kafka.server/request_bytes",
    description: "Total request bytes sent to the cluster",
    unit: "By",
    labels: [{ key: "type", description: "Request type" }],
  },
  {
    name: "io.confluent.kafka.server/response_bytes",
    description: "Total response bytes received from the cluster",
    unit: "By",
    labels: [{ key: "type", description: "Request type" }],
  },
  {
    name: "io.confluent.kafka.server/active_connection_count",
    description: "Number of active authenticated connections to the cluster",
    unit: "1",
    labels: [],
  },
  {
    name: "io.confluent.kafka.server/partition_count",
    description: "Number of partitions in the cluster",
    unit: "1",
    labels: [],
  },
  {
    name: "io.confluent.kafka.server/successful_authentication_count",
    description: "Number of successful authentications",
    unit: "1",
    labels: [],
  },
];

export class ListMetricsHandler extends BaseToolHandler {
  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const clientManager = runtime.clientManager;
    const { resource_type } = listMetricsArguments.parse(toolArguments);

    try {
      const telemetryClient =
        clientManager.getConfluentCloudTelemetryRestClient();

      // Fetch both metrics and resources descriptors
      const [metricsResponse, resourcesResponse] = await Promise.all([
        telemetryClient.GET(
          "/v2/metrics/{dataset}/descriptors/metrics" as never,
          { params: { path: { dataset: "cloud" } } } as never,
        ) as Promise<{ data?: DescriptorResponse }>,
        telemetryClient.GET(
          "/v2/metrics/{dataset}/descriptors/resources" as never,
          { params: { path: { dataset: "cloud" } } } as never,
        ) as Promise<{ data?: DescriptorResponse }>,
      ]);

      const metrics = (metricsResponse.data as DescriptorResponse)?.data as
        | MetricDescriptor[]
        | undefined;
      const resources = (resourcesResponse.data as DescriptorResponse)?.data as
        | ResourceDescriptor[]
        | undefined;

      if (!metrics || metrics.length === 0) {
        return this.createResponse(
          "No metrics descriptors available from the Telemetry API.",
          true,
        );
      }

      // Filter by resource type if specified
      let filteredMetrics = resource_type
        ? metrics.filter((m) => m.resources.includes(resource_type))
        : metrics;

      // The descriptors endpoint may not list Kafka server metrics depending
      // on API key permissions, but they still work when queried directly.
      // Include well-known Kafka server metrics as a fallback.
      if (
        (!resource_type || resource_type === "kafka") &&
        !filteredMetrics.some((m) =>
          m.name.startsWith("io.confluent.kafka.server/"),
        )
      ) {
        const kafkaServerMetrics: MetricDescriptor[] = KAFKA_SERVER_METRICS.map(
          (m) => ({
            ...m,
            type: "GAUGE_DOUBLE",
            unit: m.unit,
            lifecycle_stage: "GENERAL_AVAILABILITY",
            resources: ["kafka"],
          }),
        );
        filteredMetrics = [...kafkaServerMetrics, ...filteredMetrics];
      }

      // Format resources section
      const lines: string[] = [];

      if (resources && resources.length > 0) {
        const relevantResources = resource_type
          ? resources.filter((r) => r.type === resource_type)
          : resources;

        if (relevantResources.length > 0) {
          lines.push("Resource Types and Filter Fields:");
          for (const r of relevantResources) {
            lines.push(`  ${r.type}: ${r.description}`);
            for (const label of r.labels) {
              lines.push(`    resource.${label.key} — ${label.description}`);
            }
          }
          lines.push("");
        }
      }

      // Format metrics
      lines.push(
        `Available Metrics${resource_type ? ` (${resource_type})` : ""}: ${filteredMetrics.length}`,
      );
      lines.push("");

      for (const m of filteredMetrics) {
        lines.push(`${m.name}`);
        lines.push(`  ${m.description}`);
        lines.push(
          `  Type: ${m.type} | Unit: ${m.unit} | Resources: ${m.resources.join(", ")}`,
        );
        if (m.labels.length > 0) {
          const labelKeys = m.labels.map((l) => `metric.${l.key}`).join(", ");
          lines.push(`  Filter/group_by labels: ${labelKeys}`);
        }
        lines.push("");
      }

      return this.createResponse(lines.join("\n").trimEnd());
    } catch (error) {
      logger.error({ error }, "Error in ListMetricsHandler");
      return this.createResponse(
        `Failed to list metrics: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.LIST_METRICS,
      description:
        "List available Confluent Cloud metrics and their filter fields from the Telemetry API. Use this tool BEFORE query-metrics to discover valid metric names, resource filter fields, and grouping labels. This avoids guessing metric names.",
      inputSchema: listMetricsArguments.shape,
      annotations: READ_ONLY,
    };
  }

  enabledConnectionIds(runtime: ServerRuntime): string[] {
    return connectionIdsWhere(runtime.config.connections, hasTelemetry);
  }
}
