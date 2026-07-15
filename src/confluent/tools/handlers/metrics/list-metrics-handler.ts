import type { ConfluentRestClient } from "@src/confluent/client-manager.js";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  READ_ONLY,
  ToolCategory,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { hasTelemetryOrOAuth } from "@src/confluent/tools/connection-predicates.js";
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
    const { resource_type } = listMetricsArguments.parse(toolArguments);
    const { clientManager } = this.resolveConnection(runtime, toolArguments);

    try {
      const { metrics, resources } = await fetchDescriptors(
        clientManager.getConfluentCloudTelemetryRestClient(),
      );

      if (!metrics || metrics.length === 0) {
        return this.createResponse(
          "No metrics descriptors available from the Telemetry API.",
          true,
        );
      }

      const filteredMetrics = withKafkaServerFallback(
        filterMetricsByResourceType(metrics, resource_type),
        resource_type,
      );

      const lines = [
        ...formatResourcesSection(resources, resource_type),
        ...formatMetricsSection(filteredMetrics, resource_type),
      ];

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
  readonly category = ToolCategory.Metrics;
  readonly predicate = hasTelemetryOrOAuth;
}

type ResourceType = z.infer<typeof listMetricsArguments>["resource_type"];

/**
 * Fetch the metrics and resources descriptor lists from the Telemetry API in
 * parallel, unwrapping each response's nested `data.data` payload.
 */
async function fetchDescriptors(telemetryClient: ConfluentRestClient): Promise<{
  metrics?: MetricDescriptor[];
  resources?: ResourceDescriptor[];
}> {
  const [metricsResponse, resourcesResponse] = await Promise.all([
    telemetryClient.GET(
      "/v2/metrics/{dataset}/descriptors/metrics" as never,
      {
        params: { path: { dataset: "cloud" } },
      } as never,
    ) as Promise<{ data?: DescriptorResponse }>,
    telemetryClient.GET(
      "/v2/metrics/{dataset}/descriptors/resources" as never,
      { params: { path: { dataset: "cloud" } } } as never,
    ) as Promise<{ data?: DescriptorResponse }>,
  ]);

  return {
    metrics: (metricsResponse.data as DescriptorResponse)?.data as
      | MetricDescriptor[]
      | undefined,
    resources: (resourcesResponse.data as DescriptorResponse)?.data as
      | ResourceDescriptor[]
      | undefined,
  };
}

function filterMetricsByResourceType(
  metrics: MetricDescriptor[],
  resourceType: ResourceType,
): MetricDescriptor[] {
  return resourceType
    ? metrics.filter((m) => m.resources.includes(resourceType))
    : metrics;
}

/**
 * Prepend well-known Kafka server metrics when the filtered set covers Kafka
 * yet lacks them. The descriptors endpoint may omit these depending on API key
 * permissions, but they remain queryable directly, so we surface them anyway.
 */
function withKafkaServerFallback(
  filteredMetrics: MetricDescriptor[],
  resourceType: ResourceType,
): MetricDescriptor[] {
  const kafkaInScope = !resourceType || resourceType === "kafka";
  const alreadyPresent = filteredMetrics.some((m) =>
    m.name.startsWith("io.confluent.kafka.server/"),
  );
  if (!kafkaInScope || alreadyPresent) {
    return filteredMetrics;
  }

  const kafkaServerMetrics: MetricDescriptor[] = KAFKA_SERVER_METRICS.map(
    (m) => ({
      ...m,
      type: "GAUGE_DOUBLE",
      unit: m.unit,
      lifecycle_stage: "GENERAL_AVAILABILITY",
      resources: ["kafka"],
    }),
  );
  return [...kafkaServerMetrics, ...filteredMetrics];
}

function formatResourcesSection(
  resources: ResourceDescriptor[] | undefined,
  resourceType: ResourceType,
): string[] {
  const relevantResources = (resources ?? []).filter(
    (r) => !resourceType || r.type === resourceType,
  );
  if (relevantResources.length === 0) {
    return [];
  }

  const lines = ["Resource Types and Filter Fields:"];
  for (const r of relevantResources) {
    lines.push(`  ${r.type}: ${r.description}`);
    for (const label of r.labels) {
      lines.push(`    resource.${label.key} — ${label.description}`);
    }
  }
  lines.push("");
  return lines;
}

function formatMetricsSection(
  filteredMetrics: MetricDescriptor[],
  resourceType: ResourceType,
): string[] {
  const lines = [
    `Available Metrics${resourceType ? ` (${resourceType})` : ""}: ${filteredMetrics.length}`,
    "",
  ];

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
  return lines;
}
