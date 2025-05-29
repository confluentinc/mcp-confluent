import { z } from "zod";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { logger } from "@src/logger.js";
import { BaseToolHandler } from "../../base-tools.js";

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
    clientManager: unknown,
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
    clientManager: unknown,
    args: { resourceIds?: Record<string, string[] | string> },
  ): Promise<unknown> {
    const { resourceIds } = args;
    // Only add resource IDs as query params, do not include interval.start or interval.end
    const searchParams = new URLSearchParams();
    if (resourceIds && typeof resourceIds === "object") {
      for (const [key, value] of Object.entries(resourceIds)) {
        if (Array.isArray(value)) {
          for (const v of value) {
            searchParams.append(key, v);
          }
        } else if (typeof value === "string") {
          searchParams.append(key, value);
        }
      }
    }
    // @ts-expect-error: config is present on DefaultClientManager
    const baseUrl = (clientManager as unknown).config.endpoints.telemetry;
    const url = `${baseUrl}/v2/metrics/cloud/export?${searchParams.toString()}`;
    logger.info(`[GetConfluentCloudMetricsHandler] Fetching: ${url}`);
    logger.info(
      `[GetConfluentCloudMetricsHandler] Headers: Authorization: Basic <redacted>, Accept: application/json, text/plain, */*`,
    );
    // @ts-expect-error: config is present on DefaultClientManager
    const { apiKey, apiSecret } = (clientManager as unknown).config.auth.cloud;
    const authHeader = `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`;
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: authHeader,
          Accept: "application/json, text/plain, */*",
        },
      });
      const data = await response.text();
      logger.info(
        `[GetConfluentCloudMetricsHandler] Response: ${data.substring(0, 500)}`,
      ); // Log first 500 chars for brevity
      logger.info(
        `[GetConfluentCloudMetricsHandler] Response status: ${response.status}, OK: ${response.ok}`,
      );

      // Return the raw string data
      if (!response.ok) {
        return { error: JSON.stringify(data) };
      }

      return this.createResponse(data, false, {
        status: response.status,
        headers: response.headers,
      });
    } catch (error) {
      logger.error(`[GetConfluentCloudMetricsHandler] Error: ${error}`);
      return {
        error: JSON.stringify(
          JSON.stringify(
            {
              error: error instanceof Error ? error.message : String(error),
            },
            null,
            2,
          ),
        ),
      };
    }
  }
}
