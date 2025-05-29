import { z } from "zod";
import {
  BaseToolHandler,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ClientManager } from "@src/confluent/client-manager.js";
import { CallToolResult } from "@src/confluent/schema.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { components } from "@src/confluent/tools/handlers/metrics/types/telemetry-api.js";

type ListMetricDescriptorsResponse =
  components["schemas"]["ListMetricDescriptorsResponse"];

const getMetricsDescriptorsArguments = z.object({
  metricNamePrefix: z
    .string()
    .optional()
    .describe("Filter metrics descriptors by name prefix"),
  dataset: z
    .string()
    .default("cloud")
    .describe("Dataset name (default: cloud)"),
  pageSize: z
    .number()
    .optional()
    .describe("Maximum number of results to return"),
  pageToken: z.string().optional().describe("Token for pagination"),
});

/**
 * Handler for the metrics descriptor endpoint
 * This endpoint provides metadata about available metrics including:
 * - description
 * - available labels
 * - type information
 * - units of measurement
 */
export class GetMetricsDescriptorsHandler extends BaseToolHandler {
  getSchema() {
    return getMetricsDescriptorsArguments;
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.GET_METRICS_DESCRIPTORS,
      description:
        "Get metadata about available metrics in Confluent Cloud including descriptions, labels, and units of measurement. Use this to discover what metrics are available and how they can be filtered.",
      inputSchema: getMetricsDescriptorsArguments.shape,
    };
  }

  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const args = this.getSchema().parse(toolArguments);
    const { metricNamePrefix, dataset, pageSize, pageToken } = args;

    const telemetryClient = wrapAsPathBasedClient(
      clientManager.getConfluentCloudTelemetryRestClient(),
    );

    try {
      // Query parameters for the request
      const query: Record<string, unknown> = {};

      if (metricNamePrefix) {
        query.filter = `metric_name LIKE "${metricNamePrefix}%"`;
      }

      if (pageSize) {
        query.page_size = pageSize;
      }

      if (pageToken) {
        query.page_token = pageToken;
      }

      const { data, error } = await telemetryClient[
        `/v2/metrics/${dataset}/descriptors/metrics`
      ].GET({
        query,
      });

      if (error) {
        return this.createResponse(
          JSON.stringify(
            {
              error:
                typeof error === "object" && error.message
                  ? error.message
                  : JSON.stringify(error),
            },
            null,
            2,
          ),
        );
      }

      // Process the response to make it more user-friendly
      const descriptors = data as ListMetricDescriptorsResponse;
      const processedData = this.processDescriptors(descriptors);

      return this.createResponse(JSON.stringify(processedData, null, 2));
    } catch (error) {
      return this.createResponse(
        JSON.stringify(
          {
            error: error instanceof Error ? error.message : String(error),
          },
          null,
          2,
        ),
      );
    }
  }

  /**
   * Process the raw descriptor response to make it more user-friendly
   * This formats the data to highlight the most important information
   */
  private processDescriptors(descriptors: ListMetricDescriptorsResponse) {
    const metrics = descriptors.data.map((descriptor) => {
      return {
        name: descriptor.name,
        description: descriptor.description,
        type: descriptor.type,
        unit: descriptor.unit,
        lifecycle: descriptor.lifecycle_stage, // Using correct property name
        exportable: descriptor.exportable,
        // Format labels to be more readable
        labels: descriptor.labels.map((label) => ({
          name: label.key,
          description: label.description,
          exportable: label.exportable,
        })),
      };
    });

    return {
      metrics,
      metadata: descriptors.meta,
      links: descriptors.links,
    };
  }
}
