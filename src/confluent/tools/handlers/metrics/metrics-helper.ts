/**
 * @fileoverview Shared utilities for Confluent Cloud Metrics API (Telemetry) operations
 */

import { Client } from "openapi-fetch";
import { paths } from "@src/confluent/openapi-schema.js";
import { logger } from "@src/logger.js";
import env from "@src/env.js";
import fs from "fs";

/**
 * Metric aggregation types supported by Confluent Cloud Metrics API
 */
export type MetricAggregation = "SUM" | "AVG" | "MAX" | "MIN" | "COUNT";

/**
 * Filter operators supported by Confluent Cloud Metrics API
 */
export type FilterOperator = "EQ" | "NE" | "LT" | "GT" | "LE" | "GE";

/**
 * Time granularity for metric aggregation
 */
export type MetricGranularity = "PT1M" | "PT5M" | "PT15M" | "PT1H" | "P1D";

/**
 * Dataset types for Confluent Cloud Metrics API
 */
export type MetricDataset = "cloud" | "kafka" | "connect" | "ksqldb";

/**
 * Metric query aggregation specification
 */
export interface MetricQuery {
  metric: string;
  agg: MetricAggregation;
}

/**
 * Metric filter specification
 */
export interface MetricFilter {
  field: string;
  op: FilterOperator;
  value: string | number;
}

/**
 * Options for querying metrics
 */
export interface QueryMetricsOptions {
  aggregations: MetricQuery[];
  filters: MetricFilter[];
  granularity: MetricGranularity;
  startTime: string;
  endTime: string;
  groupBy?: string[];
  limit?: number;
}

/**
 * Metric data point returned by the API
 */
export interface MetricDataPoint {
  timestamp: string;
  value: number;
  [key: string]: string | number; // Dynamic fields from group_by
}

/**
 * Metrics API response structure
 */
export interface MetricsResponse {
  data: MetricDataPoint[];
  meta?: {
    pagination?: {
      total_size?: number;
      next_page_token?: string;
    };
  };
}

/**
 * Common Confluent Cloud metric names
 */
export const METRICS = {
  // Cluster-level metrics
  RECEIVED_BYTES: "io.confluent.kafka.server/received_bytes",
  SENT_BYTES: "io.confluent.kafka.server/sent_bytes",
  RETAINED_BYTES: "io.confluent.kafka.server/retained_bytes",
  REQUEST_BYTES: "io.confluent.kafka.server/request_bytes",
  RESPONSE_BYTES: "io.confluent.kafka.server/response_bytes",
  ACTIVE_CONNECTION_COUNT: "io.confluent.kafka.server/active_connection_count",
  CLUSTER_LOAD_PERCENT: "io.confluent.kafka.server/cluster_load_percent",

  // Record-level metrics
  RECEIVED_RECORDS: "io.confluent.kafka.server/received_records",
  SENT_RECORDS: "io.confluent.kafka.server/sent_records",

  // Request metrics
  REQUEST_COUNT: "io.confluent.kafka.server/request_count",

  // Consumer metrics
  CONSUMER_LAG_OFFSETS: "io.confluent.kafka.server/consumer_lag_offsets",
} as const;

/**
 * Common metric filter fields
 */
export const FILTER_FIELDS = {
  CLUSTER_ID: "resource.kafka.id",
  TOPIC: "metric.topic",
  PARTITION: "metric.partition",
  PRINCIPAL_ID: "metric.principal_id",
  TYPE: "metric.type",
} as const;

/**
 * Query Confluent Cloud Metrics API
 *
 * @param client - Confluent Cloud Telemetry REST client
 * @param dataset - Dataset to query (cloud, kafka, connect, ksqldb)
 * @param options - Query options including aggregations, filters, time range
 * @returns Metrics data response
 *
 * @example
 * ```typescript
 * const data = await queryMetrics(client, "cloud", {
 *   aggregations: [
 *     { metric: METRICS.RECEIVED_BYTES, agg: "SUM" }
 *   ],
 *   filters: [
 *     { field: FILTER_FIELDS.CLUSTER_ID, op: "EQ", value: "lkc-12345" }
 *   ],
 *   granularity: "PT5M",
 *   startTime: "2024-03-16T10:00:00Z",
 *   endTime: "2024-03-16T11:00:00Z"
 * });
 * ```
 */
export async function queryMetrics(
  client: Client<paths, `${string}/${string}`>,
  dataset: MetricDataset,
  options: QueryMetricsOptions,
): Promise<MetricsResponse> {
  const {
    aggregations,
    filters,
    granularity,
    startTime,
    endTime,
    groupBy,
    limit = 1000,
  } = options;

  const requestBody = {
    aggregations: aggregations.map((agg) => ({
      metric: agg.metric,
      agg: agg.agg,
    })),
    filter: {
      op: "AND",
      filters: filters.map((f) => ({
        field: f.field,
        op: f.op,
        value: String(f.value),
      })),
    },
    granularity,
    intervals: [`${startTime}/${endTime}`],
    ...(groupBy && groupBy.length > 0 ? { group_by: groupBy } : {}),
    limit,
  };

  logger.debug(
    {
      dataset,
      requestBody,
    },
    "Querying metrics API",
  );

  try {
    // Use fetch directly since Telemetry API is not in OpenAPI schema
    // and openapi-fetch may serialize it incorrectly
    const baseUrl =
      (client as { baseUrl?: string }).baseUrl ||
      env.TELEMETRY_ENDPOINT ||
      "https://api.telemetry.confluent.cloud";
    const url = `${baseUrl}/v2/metrics/${dataset}/query`;

    // Get credentials from environment
    const apiKey = env.TELEMETRY_API_KEY || env.CONFLUENT_CLOUD_API_KEY;
    const apiSecret =
      env.TELEMETRY_API_SECRET || env.CONFLUENT_CLOUD_API_SECRET;

    if (!apiKey || !apiSecret) {
      throw new Error(
        "TELEMETRY_API_KEY and TELEMETRY_API_SECRET are required",
      );
    }

    const credentials = Buffer.from(`${apiKey}:${apiSecret}`).toString(
      "base64",
    );
    const bodyString = JSON.stringify(requestBody);

    // Write to file for debugging
    try {
      fs.writeFileSync(
        "/tmp/telemetry-request.json",
        JSON.stringify(
          {
            timestamp: new Date().toISOString(),
            url,
            requestBody: JSON.parse(bodyString),
            bodyString,
            bodyLength: bodyString.length,
          },
          null,
          2,
        ),
      );
    } catch {
      // Ignore file write errors
    }

    // Console output for inspector debugging
    console.error("=== TELEMETRY API REQUEST ===");
    console.error("URL:", url);
    console.error("Request Body:", bodyString);
    console.error("Body Length:", bodyString.length);

    logger.info(
      {
        url,
        requestBody: JSON.parse(bodyString),
        bodyLength: bodyString.length,
      },
      "Making Telemetry API request",
    );

    const fetchResponse = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${credentials}`,
      },
      body: bodyString,
    });

    logger.info(
      {
        status: fetchResponse.status,
        statusText: fetchResponse.statusText,
        headers: Object.fromEntries(fetchResponse.headers.entries()),
      },
      "Received Telemetry API response",
    );

    const responseData = await fetchResponse.json();

    // Write response to file for debugging
    try {
      fs.writeFileSync(
        "/tmp/telemetry-response.json",
        JSON.stringify(
          {
            timestamp: new Date().toISOString(),
            status: fetchResponse.status,
            statusText: fetchResponse.statusText,
            responseData,
          },
          null,
          2,
        ),
      );
    } catch {
      // Ignore file write errors
    }

    // Console output for inspector debugging
    console.error("=== TELEMETRY API RESPONSE ===");
    console.error("Status:", fetchResponse.status, fetchResponse.statusText);
    console.error("Response Data:", JSON.stringify(responseData, null, 2));

    if (responseData.errors) {
      logger.error(
        {
          requestBody: JSON.parse(bodyString),
          responseData,
        },
        "API returned errors",
      );
    }

    if (!fetchResponse.ok) {
      logger.error({ error: responseData }, "Metrics API error");
      throw new Error(`Metrics API error: ${JSON.stringify(responseData)}`);
    }

    logger.debug(
      {
        dataPoints: responseData?.data?.length || 0,
      },
      "Metrics query successful",
    );

    return responseData as MetricsResponse;
  } catch (error) {
    logger.error({ error, dataset, options }, "Failed to query metrics");
    throw error;
  }
}

/**
 * Time range presets
 */
export type TimeRangePreset = "5m" | "15m" | "1h" | "6h" | "24h" | "7d";

/**
 * Get start and end timestamps for a time range
 *
 * @param range - Time range preset or number of minutes
 * @returns Start and end ISO 8601 timestamps
 *
 * @example
 * ```typescript
 * const { start, end } = getTimeRange("1h");
 * // Returns timestamps for last 1 hour
 * ```
 */
export function getTimeRange(range: TimeRangePreset | number): {
  start: string;
  end: string;
} {
  const now = new Date();
  const start = new Date(now);

  let minutes: number;

  if (typeof range === "number") {
    minutes = range;
  } else {
    const rangeMap: Record<TimeRangePreset, number> = {
      "5m": 5,
      "15m": 15,
      "1h": 60,
      "6h": 360,
      "24h": 1440,
      "7d": 10080,
    };
    minutes = rangeMap[range];
  }

  start.setMinutes(start.getMinutes() - minutes);

  return {
    start: start.toISOString(),
    end: now.toISOString(),
  };
}

/**
 * Parse a time range string to minutes
 *
 * @param range - Time range string (e.g., "1h", "30m", "7d")
 * @returns Number of minutes
 */
export function parseTimeRangeMinutes(range: string): number {
  const match = range.match(/^(\d+)([mhd])$/);
  if (!match || !match[1] || !match[2]) {
    throw new Error(
      `Invalid time range format: ${range}. Expected format: 30m, 1h, 7d`,
    );
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  const multipliers: Record<string, number> = {
    m: 1,
    h: 60,
    d: 1440,
  };

  const multiplier = multipliers[unit];
  if (multiplier === undefined) {
    throw new Error(`Invalid time unit: ${unit}. Expected: m, h, or d`);
  }

  return value * multiplier;
}

/**
 * Format bytes to human-readable format
 *
 * @param bytes - Number of bytes
 * @param decimals - Number of decimal places (default: 2)
 * @returns Formatted string (e.g., "1.23 MB")
 *
 * @example
 * ```typescript
 * formatBytes(1234567) // "1.18 MB"
 * formatBytes(1234567, 0) // "1 MB"
 * ```
 */
export function formatBytes(bytes: number, decimals: number = 2): string {
  if (bytes === 0) return "0 B";
  if (bytes < 0) return `-${formatBytes(-bytes, decimals)}`;

  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / Math.pow(k, i);

  return `${value.toFixed(decimals)} ${sizes[i]}`;
}

/**
 * Format bytes per second to rate
 *
 * @param bytesPerSecond - Bytes per second
 * @param decimals - Number of decimal places (default: 2)
 * @returns Formatted rate string (e.g., "1.23 MB/s")
 */
export function formatRate(
  bytesPerSecond: number,
  decimals: number = 2,
): string {
  return `${formatBytes(bytesPerSecond, decimals)}/s`;
}

/**
 * Format a number with thousands separators
 *
 * @param value - Number to format
 * @returns Formatted string (e.g., "1,234,567")
 */
export function formatNumber(value: number): string {
  return value.toLocaleString();
}

/**
 * Format an ISO 8601 timestamp to human-readable format
 *
 * @param iso - ISO 8601 timestamp
 * @param includeTime - Include time component (default: true)
 * @returns Formatted timestamp
 */
export function formatTimestamp(
  iso: string,
  includeTime: boolean = true,
): string {
  const date = new Date(iso);

  if (includeTime) {
    return date.toLocaleString();
  }

  return date.toLocaleDateString();
}

/**
 * Calculate average of metric values
 *
 * @param dataPoints - Array of metric data points
 * @param valueKey - Key to extract value from (default: "value")
 * @returns Average value
 */
export function calculateAverage(
  dataPoints: MetricDataPoint[],
  valueKey: string = "value",
): number {
  if (dataPoints.length === 0) return 0;

  const sum = dataPoints.reduce((acc, point) => {
    const value = point[valueKey];
    return acc + (typeof value === "number" ? value : 0);
  }, 0);

  return sum / dataPoints.length;
}

/**
 * Calculate sum of metric values
 *
 * @param dataPoints - Array of metric data points
 * @param valueKey - Key to extract value from (default: "value")
 * @returns Sum of values
 */
export function calculateSum(
  dataPoints: MetricDataPoint[],
  valueKey: string = "value",
): number {
  return dataPoints.reduce((acc, point) => {
    const value = point[valueKey];
    return acc + (typeof value === "number" ? value : 0);
  }, 0);
}

/**
 * Calculate max of metric values
 *
 * @param dataPoints - Array of metric data points
 * @param valueKey - Key to extract value from (default: "value")
 * @returns Maximum value
 */
export function calculateMax(
  dataPoints: MetricDataPoint[],
  valueKey: string = "value",
): number {
  if (dataPoints.length === 0) return 0;

  return Math.max(
    ...dataPoints.map((point) => {
      const value = point[valueKey];
      return typeof value === "number" ? value : 0;
    }),
  );
}

/**
 * Calculate percentile of metric values
 *
 * @param dataPoints - Array of metric data points
 * @param percentile - Percentile to calculate (0-100)
 * @param valueKey - Key to extract value from (default: "value")
 * @returns Percentile value
 */
export function calculatePercentile(
  dataPoints: MetricDataPoint[],
  percentile: number,
  valueKey: string = "value",
): number {
  if (dataPoints.length === 0) return 0;
  if (percentile < 0 || percentile > 100) {
    throw new Error("Percentile must be between 0 and 100");
  }

  const values = dataPoints
    .map((point) => point[valueKey])
    .filter((value): value is number => typeof value === "number")
    .sort((a, b) => a - b);

  if (values.length === 0) return 0;

  const index = (percentile / 100) * (values.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;

  const lowerValue = values[lower];
  const upperValue = values[upper];

  if (lowerValue === undefined || upperValue === undefined) return 0;
  if (lower === upper) return lowerValue;

  return lowerValue * (1 - weight) + upperValue * weight;
}

/**
 * Aggregate metrics by time period
 *
 * @param dataPoints - Array of metric data points
 * @returns Summary statistics
 */
export function aggregateMetrics(dataPoints: MetricDataPoint[]): {
  count: number;
  sum: number;
  avg: number;
  max: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
} {
  if (dataPoints.length === 0) {
    return {
      count: 0,
      sum: 0,
      avg: 0,
      max: 0,
      min: 0,
      p50: 0,
      p95: 0,
      p99: 0,
    };
  }

  const values = dataPoints
    .map((point) => point.value)
    .filter((value): value is number => typeof value === "number");

  const minValue = values.length > 0 ? Math.min(...values) : 0;

  return {
    count: values.length,
    sum: calculateSum(dataPoints),
    avg: calculateAverage(dataPoints),
    max: calculateMax(dataPoints),
    min: minValue,
    p50: calculatePercentile(dataPoints, 50),
    p95: calculatePercentile(dataPoints, 95),
    p99: calculatePercentile(dataPoints, 99),
  };
}

/**
 * Get the appropriate granularity for a time range
 *
 * @param timeRangeMinutes - Time range in minutes
 * @returns Recommended granularity
 */
export function getRecommendedGranularity(
  timeRangeMinutes: number,
): MetricGranularity {
  if (timeRangeMinutes <= 60) return "PT1M";
  if (timeRangeMinutes <= 360) return "PT5M";
  if (timeRangeMinutes <= 1440) return "PT15M";
  if (timeRangeMinutes <= 10080) return "PT1H";
  return "P1D";
}

/**
 * Extract the latest value from metrics response
 *
 * @param response - Metrics API response
 * @param metricName - Name of the metric to extract (optional, uses first aggregation if not specified)
 * @returns Latest metric value or 0 if no data
 */
export function getLatestValue(
  response: MetricsResponse,
  metricName?: string,
): number {
  if (!response.data || response.data.length === 0) return 0;

  const latestPoint = response.data[response.data.length - 1];
  if (!latestPoint) return 0;

  if (metricName) {
    const value = latestPoint[metricName];
    return typeof value === "number" ? value : 0;
  }

  return typeof latestPoint.value === "number" ? latestPoint.value : 0;
}

/**
 * Group metric data points by a field
 *
 * @param dataPoints - Array of metric data points
 * @param groupByField - Field to group by
 * @returns Map of field values to data points
 */
export function groupMetricsBy(
  dataPoints: MetricDataPoint[],
  groupByField: string,
): Map<string, MetricDataPoint[]> {
  const groups = new Map<string, MetricDataPoint[]>();

  for (const point of dataPoints) {
    const key = String(point[groupByField] ?? "unknown");
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(point);
  }

  return groups;
}

/**
 * Calculate rate from total bytes over time period
 *
 * @param totalBytes - Total bytes transferred
 * @param timeRangeMinutes - Time period in minutes
 * @returns Bytes per second
 */
export function calculateBytesPerSecond(
  totalBytes: number,
  timeRangeMinutes: number,
): number {
  if (timeRangeMinutes <= 0) return 0;
  const seconds = timeRangeMinutes * 60;
  return totalBytes / seconds;
}
