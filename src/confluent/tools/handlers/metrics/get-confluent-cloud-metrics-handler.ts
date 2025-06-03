import { z } from "zod";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { logger } from "@src/logger.js";
import { BaseToolHandler } from "../../base-tools.js";
import { ClientManager } from "@src/confluent/client-manager.js";

const resourceIdSchema = z.object({
  "resource.kafka.id": z
    .array(z.string().regex(/^lkc-/))
    .optional()
    .default(
      process.env.KAFKA_CLUSTER_ID ? [process.env.KAFKA_CLUSTER_ID] : [],
    ),
  "resource.schema_registry.id": z.array(z.string().regex(/^lsrc-/)).optional(),
  "resource.ksql.id": z.array(z.string().regex(/^lksqlc-/)).optional(),
  "resource.compute_pool.id": z.array(z.string().regex(/^lfcp-/)).optional(),
  "resource.connector.id": z.array(z.string().regex(/^lcc-/)).optional(),
});

const getConfluentCloudMetricsArguments = z.object({
  resourceIds: resourceIdSchema
    .partial()
    .default(
      process.env.KAFKA_CLUSTER_ID
        ? { "resource.kafka.id": [process.env.KAFKA_CLUSTER_ID] }
        : {},
    )
    .refine((obj) => Object.keys(obj).length > 0, {
      message: "At least one resource type must be specified in resourceIds.",
    }),
  intervalStart: z.string().optional(),
  intervalEnd: z.string().optional(),
});

export class GetConfluentCloudMetricsHandler extends BaseToolHandler {
  getSchema() {
    return getConfluentCloudMetricsArguments;
  }

  getToolConfig() {
    return {
      name: ToolName.GET_CONFLUENT_CLOUD_METRICS,
      description:
        "Get metrics for Confluent Cloud resources (Kafka, Schema Registry, KSQL, Compute Pool, Connector) using the export endpoint. Accepts multiple resource IDs and returns Prometheus/OpenMetrics format. Confluent MetricsViewer is required to visualize the metrics.",
      inputSchema: getConfluentCloudMetricsArguments.shape,
    };
  }

  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<{ content: { type: "text"; text: string }[] }> {
    const args = this.getSchema().parse(toolArguments ?? {});
    const result = await this.handleExportEndpoint(clientManager, args);
    if (result && typeof result === "object" && "error" in result) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${result.error}`,
          },
        ],
      };
    }
    return {
      content: [
        {
          type: "text",
          text: typeof result === "string" ? result : JSON.stringify(result),
        },
      ],
    };
  }

  private async handleExportEndpoint(
    clientManager: ClientManager,
    args: { resourceIds?: Record<string, string[] | string> },
  ): Promise<unknown> {
    const { resourceIds } = args;

    try {
      const telemetryClient =
        clientManager.getConfluentCloudTelemetryRestClient();

      // Build query parameters for the export endpoint
      const queryParams: Record<string, string | string[]> = {};

      if (resourceIds && typeof resourceIds === "object") {
        for (const [key, value] of Object.entries(resourceIds)) {
          if (Array.isArray(value)) {
            queryParams[key] = value;
          } else if (typeof value === "string") {
            queryParams[key] = value;
          }
        }
      }

      // Make request using the telemetry client
      const response = await telemetryClient.GET(
        "/v2/metrics/{dataset}/export",
        {
          params: {
            path: {
              dataset: "cloud",
            },
            query: queryParams,
          },
          parseAs: "text", // This tells the client to return raw text instead of trying to parse JSON
        },
      );

      if (response.error) {
        logger.error(
          `[GetConfluentCloudMetricsHandler] API Error: ${JSON.stringify(response.error)}`,
        );
        return { error: JSON.stringify(response.error) };
      }

      // The response.data will be the raw text (Prometheus/OpenMetrics format)
      const data = response.data as string;

      return this.createResponse(data, false, {
        status: response.response.status,
        headers: Object.fromEntries(response.response.headers.entries()),
      });
    } catch (error) {
      logger.error(`[GetConfluentCloudMetricsHandler] Error: ${error}`);
      return {
        error: JSON.stringify(
          {
            error: error instanceof Error ? error.message : String(error),
          },
          null,
          2,
        ),
      };
    }
  }
}
