import { ClientManager } from "@src/confluent/client-manager.js";

/**
 * Flink statement metrics from the Confluent Cloud Telemetry API.
 * Based on: https://api.telemetry.confluent.cloud/docs/descriptors/datasets/cloud
 */
export interface TaskMetrics {
  taskId: string;
  numRecordsIn?: number;
  numRecordsOut?: number;
  numBytesIn?: number;
  numBytesOut?: number;
  backpressureTimeMsPerSecond?: number;
  busyTimeMsPerSecond?: number;
  idleTimeMsPerSecond?: number;
  stateSizeBytes?: number;
}

export interface SplitMetrics {
  splitName: string; // e.g., "orders-0" (topic-partition)
  currentWatermarkMs?: number;
  watermarkActiveTimeMsPerSecond?: number;
  watermarkPausedTimeMsPerSecond?: number;
  watermarkIdleTimeMsPerSecond?: number;
}

export interface FlinkStatementMetrics {
  // Throughput (aggregated)
  numRecordsIn?: number;
  numRecordsOut?: number;
  numRecordsInFromTopics?: number;
  numRecordsInFromFiles?: number;
  numBytesIn?: number;
  numBytesOut?: number;

  // Lag
  pendingRecords?: number;

  // Performance (aggregated)
  backpressureTimeMsPerSecond?: number;
  busyTimeMsPerSecond?: number;
  idleTimeMsPerSecond?: number;

  // Watermarks
  currentInputWatermarkMs?: number;
  currentOutputWatermarkMs?: number;
  watermarkLagMs?: number;

  // Late data
  numLateRecordsIn?: number;
  maxInputLatenessMs?: number;

  // Resource usage
  currentCfus?: number;
  cfuMinutesConsumed?: number;
  stateSizeBytes?: number;

  // Parallelism
  currentParallelism?: number;
  maxParallelism?: number;

  // Status
  status?: string;

  // Per-task breakdown (task IDs are hex hashes)
  byTask?: TaskMetrics[];

  // Per-split breakdown (split names are readable: topic-partition)
  bySplit?: SplitMetrics[];
}

export interface MetricDataPoint {
  value: number;
  timestamp: string;
}

export interface MetricQueryResult {
  metric: string;
  data: MetricDataPoint[];
}

// Response format when using format: "GROUPED"
interface GroupedTelemetryResponse {
  data?: Array<{
    "metric.flink_task.id"?: string;
    "metric.flink_operator.id"?: string;
    "metric.flink_split"?: string;
    points?: Array<{
      timestamp?: string;
      value?: number;
    }>;
  }>;
  errors?: Array<{ detail?: string }>;
}

// Long.MIN_VALUE indicates no watermark set
const LONG_MIN_VALUE = -9223372036854776000;

/**
 * Query Flink statement metrics from the Confluent Cloud Telemetry API.
 *
 * @param clientManager - The client manager with telemetry client
 * @param options - Query options
 * @returns Aggregated metrics for the statement
 */
export async function getStatementMetrics(
  clientManager: ClientManager,
  options: {
    statementName: string;
    computePoolId: string;
    intervalMinutes?: number;
    includeTaskBreakdown?: boolean;
    includeSplitBreakdown?: boolean;
  },
): Promise<{
  success: boolean;
  metrics?: FlinkStatementMetrics;
  error?: string;
}> {
  const {
    statementName,
    computePoolId,
    intervalMinutes = 5,
    includeTaskBreakdown = false,
    includeSplitBreakdown = false,
  } = options;

  // Calculate time range
  const now = new Date();
  const startTime = new Date(now.getTime() - intervalMinutes * 60 * 1000);

  // Metrics to query - these are the most diagnostic-relevant ones
  const metricsToQuery = [
    "io.confluent.flink/num_records_in",
    "io.confluent.flink/num_records_out",
    "io.confluent.flink/pending_records",
    "io.confluent.flink/task/backpressure_time_ms_per_second",
    "io.confluent.flink/task/busy_time_ms_per_second",
    "io.confluent.flink/task/idle_time_ms_per_second",
    "io.confluent.flink/current_input_watermark_milliseconds",
    "io.confluent.flink/current_output_watermark_milliseconds",
    "io.confluent.flink/num_late_records_in",
    "io.confluent.flink/max_input_lateness_milliseconds",
    "io.confluent.flink/statement_utilization/current_cfus",
    "io.confluent.flink/operator/state_size_bytes",
    "io.confluent.flink/statement_status",
  ];

  try {
    const telemetryClient =
      clientManager.getConfluentCloudTelemetryRestClient();
    const metrics: FlinkStatementMetrics = {};

    // Query each metric individually (API only allows one aggregation per request)
    for (const metric of metricsToQuery) {
      try {
        const response = (await telemetryClient.POST(
          "/v2/metrics/{dataset}/query" as never,
          {
            params: { path: { dataset: "cloud" } },
            body: {
              aggregations: [{ metric }],
              filter: {
                op: "AND",
                filters: [
                  {
                    field: "resource.flink_statement.name",
                    op: "EQ",
                    value: statementName,
                  },
                  {
                    field: "resource.compute_pool.id",
                    op: "EQ",
                    value: computePoolId,
                  },
                ],
              },
              granularity: "PT1M",
              intervals: [`${startTime.toISOString()}/${now.toISOString()}`],
              limit: 1000,
              group_by: ["metric.flink_task.id"],
              format: "GROUPED",
            },
          } as never,
        )) as { data?: GroupedTelemetryResponse; error?: unknown };

        const data = response.data as GroupedTelemetryResponse;
        if (data?.data && data.data.length > 0) {
          // Aggregate values across all tasks
          // Use SUM for counters, MAX for backpressure (bottleneck), AVG for rates
          let sumValue = 0;
          let maxValue = 0;
          let count = 0;
          for (const item of data.data) {
            const points = item.points;
            const pointValue = points?.[points.length - 1]?.value;
            if (
              pointValue !== undefined &&
              pointValue > LONG_MIN_VALUE + 1000000
            ) {
              sumValue += pointValue;
              maxValue = Math.max(maxValue, pointValue);
              count++;
            }
          }
          if (count > 0) {
            const avgValue = sumValue / count;
            // Map metric names to our interface with appropriate aggregation
            if (
              metric.includes("num_records_in") &&
              !metric.includes("from_") &&
              !metric.includes("late")
            ) {
              metrics.numRecordsIn = sumValue; // SUM for counters
            } else if (
              metric.includes("num_records_out") &&
              !metric.includes("task") &&
              !metric.includes("operator")
            ) {
              metrics.numRecordsOut = sumValue;
            } else if (metric.includes("pending_records")) {
              metrics.pendingRecords = sumValue;
            } else if (metric.includes("backpressure_time")) {
              // Convert ms/second to percentage (1000ms = 100%)
              metrics.backpressureTimeMsPerSecond = (maxValue / 1000) * 100; // MAX to find bottleneck
            } else if (metric.includes("busy_time")) {
              metrics.busyTimeMsPerSecond = (avgValue / 1000) * 100; // AVG as percentage
            } else if (
              metric.includes("idle_time") &&
              metric.includes("task")
            ) {
              metrics.idleTimeMsPerSecond = (avgValue / 1000) * 100;
            } else if (metric.includes("current_input_watermark")) {
              metrics.currentInputWatermarkMs = maxValue; // MAX for watermarks
            } else if (metric.includes("current_output_watermark")) {
              metrics.currentOutputWatermarkMs = maxValue;
            } else if (metric.includes("num_late_records")) {
              metrics.numLateRecordsIn = sumValue;
            } else if (metric.includes("max_input_lateness")) {
              metrics.maxInputLatenessMs = maxValue; // MAX for lateness
            } else if (metric.includes("current_cfus")) {
              metrics.currentCfus = sumValue; // SUM for CFUs
            } else if (metric.includes("state_size_bytes")) {
              metrics.stateSizeBytes = sumValue; // SUM for total state
            }
          }
        }
      } catch {
        // Continue with other metrics if one fails
      }
    }

    // Calculate watermark lag if we have both input and output watermarks
    if (
      metrics.currentInputWatermarkMs !== undefined &&
      metrics.currentOutputWatermarkMs !== undefined
    ) {
      metrics.watermarkLagMs =
        metrics.currentInputWatermarkMs - metrics.currentOutputWatermarkMs;
    }

    // Query per-task breakdown if requested
    if (includeTaskBreakdown) {
      const taskMetrics = await queryTaskMetrics(telemetryClient, {
        statementName,
        computePoolId,
        startTime,
        now,
      });
      if (taskMetrics.length > 0) {
        metrics.byTask = taskMetrics;
      }
    }

    // Query per-split breakdown if requested
    if (includeSplitBreakdown) {
      const splitMetrics = await querySplitMetrics(telemetryClient, {
        statementName,
        computePoolId,
        startTime,
        now,
      });
      if (splitMetrics.length > 0) {
        metrics.bySplit = splitMetrics;
      }
    }

    return { success: true, metrics };
  } catch (error) {
    return {
      success: false,
      error: `Failed to query metrics: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Analyze metrics and return diagnostic insights.
 */
export function analyzeMetrics(metrics: FlinkStatementMetrics): {
  issues: Array<{
    type: string;
    severity: "low" | "medium" | "high" | "critical";
    description: string;
    suggestion: string;
    value?: number;
  }>;
  summary: string;
} {
  const issues: Array<{
    type: string;
    severity: "low" | "medium" | "high" | "critical";
    description: string;
    suggestion: string;
    value?: number;
  }> = [];

  // Check backpressure (high backpressure indicates downstream bottleneck)
  // Values are already in percentage (0-100)
  if (metrics.backpressureTimeMsPerSecond !== undefined) {
    const backpressurePercent = metrics.backpressureTimeMsPerSecond;
    if (backpressurePercent > 50) {
      issues.push({
        type: "high_backpressure",
        severity: "high",
        description: `High backpressure detected: ${backpressurePercent.toFixed(1)}% of time spent backpressured.`,
        suggestion:
          "Downstream operators or sinks are slow. Consider: 1) Increasing sink parallelism, 2) Optimizing sink performance, 3) Checking for slow consumers.",
        value: backpressurePercent,
      });
    } else if (backpressurePercent > 20) {
      issues.push({
        type: "moderate_backpressure",
        severity: "medium",
        description: `Moderate backpressure: ${backpressurePercent.toFixed(1)}% of time spent backpressured.`,
        suggestion: "Some downstream slowdown detected. Monitor for increases.",
        value: backpressurePercent,
      });
    }
  }

  // Check pending records (consumer lag)
  if (metrics.pendingRecords !== undefined && metrics.pendingRecords > 100000) {
    issues.push({
      type: "high_lag",
      severity: metrics.pendingRecords > 1000000 ? "high" : "medium",
      description: `High consumer lag: ${metrics.pendingRecords.toLocaleString()} pending records.`,
      suggestion:
        "Statement is falling behind input rate. Consider: 1) Increasing parallelism, 2) Optimizing query, 3) Adding more CFUs.",
      value: metrics.pendingRecords,
    });
  }

  // Check for late data
  if (metrics.numLateRecordsIn !== undefined && metrics.numLateRecordsIn > 0) {
    const severity =
      metrics.numLateRecordsIn > 10000
        ? "high"
        : metrics.numLateRecordsIn > 1000
          ? "medium"
          : "low";
    issues.push({
      type: "late_data",
      severity,
      description: `Late records detected: ${metrics.numLateRecordsIn.toLocaleString()} records arrived after watermark.`,
      suggestion:
        "Consider: 1) Increasing watermark delay tolerance, 2) Investigating source timestamp issues, 3) Using allowed lateness in window operations.",
      value: metrics.numLateRecordsIn,
    });
  }

  // Check max lateness
  if (
    metrics.maxInputLatenessMs !== undefined &&
    metrics.maxInputLatenessMs > 60000
  ) {
    issues.push({
      type: "high_lateness",
      severity: metrics.maxInputLatenessMs > 300000 ? "high" : "medium",
      description: `High input lateness: max ${(metrics.maxInputLatenessMs / 1000).toFixed(1)}s behind watermark.`,
      suggestion:
        "Some records are arriving significantly late. This may cause data loss in window operations.",
      value: metrics.maxInputLatenessMs,
    });
  }

  // Check idle time (might indicate waiting for data)
  // Values are already in percentage (0-100)
  if (metrics.idleTimeMsPerSecond !== undefined) {
    const idlePercent = metrics.idleTimeMsPerSecond;
    if (idlePercent > 90 && metrics.numRecordsIn === 0) {
      issues.push({
        type: "no_input_data",
        severity: "medium",
        description: `Statement is mostly idle (${idlePercent.toFixed(1)}%) with no input records.`,
        suggestion:
          "Check if source topics have data. Verify topic names and connectivity.",
        value: idlePercent,
      });
    }
  }

  // Check state size (large state can cause performance issues)
  if (metrics.stateSizeBytes !== undefined) {
    const stateSizeGB = metrics.stateSizeBytes / (1024 * 1024 * 1024);
    if (stateSizeGB > 10) {
      issues.push({
        type: "large_state",
        severity: "medium",
        description: `Large state size: ${stateSizeGB.toFixed(2)} GB.`,
        suggestion:
          "Consider: 1) Adding TTL to stateful operations, 2) Using incremental checkpoints, 3) Reviewing deduplication windows.",
        value: metrics.stateSizeBytes,
      });
    }
  }

  // Build summary
  const parts: string[] = [];
  if (metrics.numRecordsIn !== undefined) {
    parts.push(`Records in: ${metrics.numRecordsIn.toLocaleString()}`);
  }
  if (metrics.numRecordsOut !== undefined) {
    parts.push(`Records out: ${metrics.numRecordsOut.toLocaleString()}`);
  }
  if (metrics.pendingRecords !== undefined) {
    parts.push(`Pending: ${metrics.pendingRecords.toLocaleString()}`);
  }
  if (metrics.backpressureTimeMsPerSecond !== undefined) {
    parts.push(
      `Backpressure: ${metrics.backpressureTimeMsPerSecond.toFixed(1)}%`,
    );
  }
  if (metrics.busyTimeMsPerSecond !== undefined) {
    parts.push(`Busy: ${metrics.busyTimeMsPerSecond.toFixed(1)}%`);
  }
  if (metrics.idleTimeMsPerSecond !== undefined) {
    parts.push(`Idle: ${metrics.idleTimeMsPerSecond.toFixed(1)}%`);
  }
  if (metrics.currentCfus !== undefined) {
    parts.push(`CFUs: ${metrics.currentCfus.toFixed(2)}`);
  }

  const summary =
    parts.length > 0 ? parts.join(" | ") : "No metrics data available";

  return { issues, summary };
}

/**
 * Query per-task metrics breakdown using GROUPED format.
 */
async function queryTaskMetrics(
  telemetryClient: ReturnType<
    ClientManager["getConfluentCloudTelemetryRestClient"]
  >,
  options: {
    statementName: string;
    computePoolId: string;
    startTime: Date;
    now: Date;
  },
): Promise<TaskMetrics[]> {
  const { statementName, computePoolId, startTime, now } = options;

  // Metrics to query per task
  const taskMetricsToQuery = [
    "io.confluent.flink/task/num_records_in",
    "io.confluent.flink/task/num_records_out",
    "io.confluent.flink/task/num_bytes_in",
    "io.confluent.flink/task/num_bytes_out",
    "io.confluent.flink/task/backpressure_time_ms_per_second",
    "io.confluent.flink/task/busy_time_ms_per_second",
    "io.confluent.flink/task/idle_time_ms_per_second",
    "io.confluent.flink/operator/state_size_bytes",
  ];

  const taskMap = new Map<string, TaskMetrics>();

  for (const metric of taskMetricsToQuery) {
    try {
      const response = (await telemetryClient.POST(
        "/v2/metrics/{dataset}/query" as never,
        {
          params: { path: { dataset: "cloud" } },
          body: {
            aggregations: [{ metric }],
            filter: {
              op: "AND",
              filters: [
                {
                  field: "resource.flink_statement.name",
                  op: "EQ",
                  value: statementName,
                },
                {
                  field: "resource.compute_pool.id",
                  op: "EQ",
                  value: computePoolId,
                },
              ],
            },
            granularity: "PT1M",
            intervals: [`${startTime.toISOString()}/${now.toISOString()}`],
            limit: 1000,
            group_by: ["metric.flink_task.id"],
            format: "GROUPED",
          },
        } as never,
      )) as { data?: GroupedTelemetryResponse; error?: unknown };

      const data = response.data as GroupedTelemetryResponse;
      if (data?.data) {
        for (const item of data.data) {
          const taskId = item["metric.flink_task.id"];
          const value = item.points?.[item.points.length - 1]?.value;
          if (!taskId || value === undefined) continue;

          if (!taskMap.has(taskId)) {
            taskMap.set(taskId, { taskId });
          }
          const taskMetrics = taskMap.get(taskId)!;

          if (metric.includes("num_records_in"))
            taskMetrics.numRecordsIn = value;
          else if (metric.includes("num_records_out"))
            taskMetrics.numRecordsOut = value;
          else if (metric.includes("num_bytes_in"))
            taskMetrics.numBytesIn = value;
          else if (metric.includes("num_bytes_out"))
            taskMetrics.numBytesOut = value;
          else if (metric.includes("backpressure"))
            taskMetrics.backpressureTimeMsPerSecond = value;
          else if (metric.includes("busy_time"))
            taskMetrics.busyTimeMsPerSecond = value;
          else if (metric.includes("idle_time"))
            taskMetrics.idleTimeMsPerSecond = value;
          else if (metric.includes("state_size"))
            taskMetrics.stateSizeBytes = value;
        }
      }
    } catch {
      // Continue with other metrics if one fails
    }
  }

  return Array.from(taskMap.values());
}

/**
 * Query per-split metrics breakdown using GROUPED format.
 * Split names are human-readable (e.g., "orders-0" for topic-partition).
 */
async function querySplitMetrics(
  telemetryClient: ReturnType<
    ClientManager["getConfluentCloudTelemetryRestClient"]
  >,
  options: {
    statementName: string;
    computePoolId: string;
    startTime: Date;
    now: Date;
  },
): Promise<SplitMetrics[]> {
  const { statementName, computePoolId, startTime, now } = options;

  // Metrics to query per split
  const splitMetricsToQuery = [
    "io.confluent.flink/split/current_watermark_ms",
    "io.confluent.flink/split/watermark_active_time_ms_per_second",
    "io.confluent.flink/split/watermark_paused_time_ms_per_second",
    "io.confluent.flink/split/watermark_idle_time_ms_per_second",
  ];

  const splitMap = new Map<string, SplitMetrics>();

  for (const metric of splitMetricsToQuery) {
    try {
      const response = (await telemetryClient.POST(
        "/v2/metrics/{dataset}/query" as never,
        {
          params: { path: { dataset: "cloud" } },
          body: {
            aggregations: [{ metric }],
            filter: {
              op: "AND",
              filters: [
                {
                  field: "resource.flink_statement.name",
                  op: "EQ",
                  value: statementName,
                },
                {
                  field: "resource.compute_pool.id",
                  op: "EQ",
                  value: computePoolId,
                },
              ],
            },
            granularity: "PT1M",
            intervals: [`${startTime.toISOString()}/${now.toISOString()}`],
            limit: 1000,
            group_by: ["metric.flink_split"],
            format: "GROUPED",
          },
        } as never,
      )) as { data?: GroupedTelemetryResponse; error?: unknown };

      const data = response.data as GroupedTelemetryResponse;
      if (data?.data) {
        for (const item of data.data) {
          const splitName = item["metric.flink_split"];
          const value = item.points?.[item.points.length - 1]?.value;
          if (!splitName || value === undefined) continue;

          // Skip Long.MIN_VALUE (no watermark set)
          if (
            metric.includes("watermark_ms") &&
            value < LONG_MIN_VALUE + 1000000
          )
            continue;

          if (!splitMap.has(splitName)) {
            splitMap.set(splitName, { splitName });
          }
          const splitMetrics = splitMap.get(splitName)!;

          if (metric.includes("current_watermark_ms"))
            splitMetrics.currentWatermarkMs = value;
          else if (metric.includes("active_time"))
            splitMetrics.watermarkActiveTimeMsPerSecond = value;
          else if (metric.includes("paused_time"))
            splitMetrics.watermarkPausedTimeMsPerSecond = value;
          else if (metric.includes("idle_time"))
            splitMetrics.watermarkIdleTimeMsPerSecond = value;
        }
      }
    } catch {
      // Continue with other metrics if one fails
    }
  }

  return Array.from(splitMap.values());
}
