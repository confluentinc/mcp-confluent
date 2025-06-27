import { ZodType } from "zod";
import { ClientManager } from "@src/confluent/client-manager.js";
import { BaseToolHandler } from "@src/confluent/tools/base-tools.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { CallToolResult } from "@src/confluent/schema.js";

import { components } from "@src/confluent/tools/handlers/metrics/types/telemetry-api.js";

type QueryRequest = components["schemas"]["QueryRequest"];
type QueryResponse = components["schemas"]["QueryResponse"];

/**
 * Aggregation type for metrics queries
 * SUM - Sum values across dimensions (default)
 * MIN - Find minimum values across dimensions
 * MAX - Find maximum values across dimensions
 */
export type AggregationType = "SUM" | "MIN" | "MAX";

export interface MetricQueryOptions {
  metrics: string[];
  intervalStart: string;
  intervalEnd: string;
  groupBy: string;
  filterField: string;
  filterValue: string;
  /**
   * Optional aggregation type. If not specified, defaults to 'SUM'
   * Use 'SUM', 'MIN', or 'MAX' to control how values are aggregated
   */
  aggregationType?: AggregationType;
  limit?: number;
  /**
   * If true, use the export endpoint instead of the query endpoint
   */
  useExportEndpoint?: boolean;
  /**
   * If true, include related metrics info in the response
   */
  includeRelatedMetrics?: boolean;
}

export abstract class MetricHandler extends BaseToolHandler {
  abstract getGroupBy(): string;
  abstract getFilterField(args: unknown): string;
  abstract getFilterValue(args: unknown): string;
  abstract getSchema(): ZodType<unknown>;

  /**
   * Gets default interval values for the last day if not provided in args
   * @returns An object with intervalStart and intervalEnd in ISO format
   */
  getDefaultIntervals(): { intervalStart: string; intervalEnd: string } {
    const endDate = new Date();
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - 1);

    return {
      intervalStart: startDate.toISOString(),
      intervalEnd: endDate.toISOString(),
    };
  }

  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const args = this.getSchema().parse(toolArguments) as MetricQueryOptions;
    // eslint-disable-next-line prefer-const
    let { metrics, intervalStart, intervalEnd, includeRelatedMetrics } = args;

    // Use default interval if not provided
    if (!intervalStart || !intervalEnd) {
      const defaultIntervals = this.getDefaultIntervals();
      intervalStart = intervalStart || defaultIntervals.intervalStart;
      intervalEnd = intervalEnd || defaultIntervals.intervalEnd;
    }

    const telemetryClient = wrapAsPathBasedClient(
      clientManager.getConfluentCloudTelemetryRestClient(),
    );

    // If includeRelatedMetrics is true, fetch metrics descriptors to provide context
    let relatedMetricsInfo: unknown | null = null;
    if (includeRelatedMetrics) {
      relatedMetricsInfo = await this.fetchRelatedMetricsInfo(
        clientManager,
        metrics,
      );
    }

    // For metric handlers, we use the query endpoint with proper group_by
    // The export endpoint is used only for general cluster metrics in the Kafka metrics handler
    const queryResults = await this.handleQueryEndpoint(telemetryClient, args);

    // If we have related metrics info and query results, combine them
    if (relatedMetricsInfo && queryResults) {
      const combinedResults = {
        metrics: JSON.parse(queryResults.toString()),
        relatedMetricsInfo,
      };
      return this.createResponse(JSON.stringify(combinedResults, null, 2));
    }

    return queryResults;
  }

  /**
   * Handles querying the metrics query endpoint with appropriate grouping
   */
  private async handleQueryEndpoint(
    telemetryClient: ReturnType<typeof wrapAsPathBasedClient>,
    args: unknown,
  ): Promise<CallToolResult> {
    const { metrics, intervalStart, intervalEnd, limit } = args as Record<
      string,
      unknown
    >;
    const allResults: Array<{
      metric: string;
      data?: QueryResponse;
      error?: string;
    }> = [];

    // Process one metric at a time since the API only supports one aggregation per request
    for (const metric of metrics as string[]) {
      const requestBody: QueryRequest = {
        aggregations: [
          {
            metric,
            agg: "SUM", // Only "SUM" is allowed by the OpenAPI type
          },
        ],
        filter: {
          field: this.getFilterField(args),
          op: "EQ",
          value: this.getFilterValue(args),
        },
        granularity: "P1D",
        group_by: [this.getGroupBy()],
        intervals: [`${intervalStart}/${intervalEnd}`],
        limit: typeof limit === "number" ? limit : 1000,
      };

      try {
        const { data, error } = await telemetryClient["/v2/metrics/query"].POST(
          {
            body: requestBody,
          },
        );

        if (error) {
          allResults.push({
            metric,
            error:
              typeof error === "object" && error.message
                ? error.message
                : JSON.stringify(error),
          });
          continue;
        }

        allResults.push({
          metric,
          data: data as QueryResponse,
        });
      } catch (error) {
        allResults.push({
          metric,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return this.createResponse(JSON.stringify(allResults, null, 2));
  }

  /**
   * Fetches related metrics information from the metrics descriptor endpoint
   * This helps provide context about metrics and how they can be used
   */
  protected async fetchRelatedMetricsInfo(
    clientManager: ClientManager,
    metricNames: string[],
  ): Promise<unknown> {
    try {
      const telemetryClient = wrapAsPathBasedClient(
        clientManager.getConfluentCloudTelemetryRestClient(),
      );

      const metricInfo: Record<string, unknown> = {};

      // For each metric, fetch its descriptor information
      for (const metric of metricNames) {
        // Extract the metric prefix (everything before the last slash)
        const metricPrefix = metric.substring(0, metric.lastIndexOf("/"));

        // Query parameters for the request
        const query: Record<string, unknown> = {
          filter: `metric_name LIKE "${metricPrefix}/%"`,
        };

        const { data, error } = await telemetryClient[
          `/v2/metrics/cloud/descriptors/metrics`
        ].GET({
          query,
        });

        if (error) {
          metricInfo[metric] = {
            error:
              typeof error === "object" && error.message
                ? error.message
                : JSON.stringify(error),
          };
          continue;
        }

        // Process the response to make it more user-friendly
        const processedData = this.processMetricDescriptors(data, metric);
        metricInfo[metric] = processedData;
      }

      return metricInfo;
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Processes metric descriptors to extract the most useful information
   */
  private processMetricDescriptors(
    descriptorsResponse: unknown,
    currentMetric: string,
  ): unknown {
    if (
      !descriptorsResponse ||
      typeof descriptorsResponse !== "object" ||
      !("data" in descriptorsResponse) ||
      !Array.isArray((descriptorsResponse as { data?: unknown[] }).data)
    ) {
      return { error: "No descriptor data available" };
    }

    type MetricDescriptor = {
      name?: string;
      description?: string;
      unit?: string;
      labels?: { key?: string; description?: string }[];
      type?: string;
      lifecycle_stage?: string;
    };
    const data = (descriptorsResponse as { data: MetricDescriptor[] }).data;

    // Find the current metric descriptor
    const currentDescriptor = data.find(
      (desc) => desc && desc.name === currentMetric,
    );

    // Find related metrics from the same family
    const relatedMetrics = data
      .filter((desc) => desc && desc.name !== currentMetric)
      .map((desc) => ({
        name: desc.name,
        description: desc.description,
        unit: desc.unit,
      }));

    return {
      descriptor: currentDescriptor
        ? {
            description: currentDescriptor.description,
            unit: currentDescriptor.unit,
            type: currentDescriptor.type,
            lifecycle: currentDescriptor.lifecycle_stage,
            labels: Array.isArray(currentDescriptor.labels)
              ? currentDescriptor.labels.map((label) => ({
                  name: label.key,
                  description: label.description,
                }))
              : [],
          }
        : null,
      relatedMetrics: relatedMetrics.length > 0 ? relatedMetrics : null,
    };
  }

  /**
   * Shared fetch logic for metrics query endpoint (for topic/principal handlers)
   */
  protected async fetchMetricsQuery(
    clientManager: ClientManager,
    requestBody: unknown,
    postFilter?: (data: unknown) => unknown,
  ): Promise<{ data?: unknown; error?: string }> {
    const telemetryClient = wrapAsPathBasedClient(
      clientManager.getConfluentCloudTelemetryRestClient(),
    );

    try {
      const { data, error } = await telemetryClient["/v2/metrics/query"].POST({
        body: requestBody as QueryRequest,
      });

      if (error) {
        return {
          error:
            typeof error === "object" && error.message
              ? error.message
              : JSON.stringify(error),
        };
      }

      return { data: postFilter ? postFilter(data) : data };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Shared logic for iterating metrics, building requestBody, applying postFilter, and returning results.
   * Used by principal and topic metrics handlers.
   */
  protected async handleMetricsWithFilter(
    clientManager: ClientManager,
    args: Record<string, unknown>,
    aggregationType: string | undefined,
    limit: number | undefined,
    intervalStart: string,
    intervalEnd: string,
    postFilter?: (data: unknown) => unknown,
  ): Promise<CallToolResult> {
    const { metrics } = args as { metrics: string[] };
    const results: Array<{ metric: string; data?: unknown; error?: string }> =
      [];
    for (const metric of metrics) {
      const requestBody = {
        aggregations: [{ metric, agg: aggregationType || "SUM" }],
        filter: {
          field: this.getFilterField(args),
          op: "EQ",
          value: this.getFilterValue(args),
        },
        granularity: "P1D",
        group_by: [this.getGroupBy()],
        intervals: [`${intervalStart}/${intervalEnd}`],
        limit: limit ?? 1000,
      };
      const { data, error } = await this.fetchMetricsQuery(
        clientManager,
        requestBody,
        postFilter,
      );
      if (error) {
        results.push({ metric, error });
      } else {
        results.push({ metric, data });
      }
    }
    return this.createResponse(JSON.stringify(results, null, 2));
  }
}
