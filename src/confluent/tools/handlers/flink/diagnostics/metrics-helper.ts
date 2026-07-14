import { BaseClientManager } from "@src/confluent/base-client-manager.js";

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
  clientManager: BaseClientManager,
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

  const now = new Date();
  const startTime = new Date(now.getTime() - intervalMinutes * 60 * 1000);
  const scope: MetricQueryScope = {
    statementName,
    computePoolId,
    startTime,
    now,
  };

  try {
    const telemetryClient =
      clientManager.getConfluentCloudTelemetryRestClient();
    const metrics = await collectAggregatedMetrics(telemetryClient, scope);

    if (includeTaskBreakdown) {
      const taskMetrics = await queryTaskMetrics(telemetryClient, scope);
      if (taskMetrics.length > 0) metrics.byTask = taskMetrics;
    }

    if (includeSplitBreakdown) {
      const splitMetrics = await querySplitMetrics(telemetryClient, scope);
      if (splitMetrics.length > 0) metrics.bySplit = splitMetrics;
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
  issues: MetricIssue[];
  summary: string;
} {
  const issues = ISSUE_DETECTORS.map((detect) => detect(metrics)).filter(
    (issue): issue is MetricIssue => issue !== undefined,
  );

  return { issues, summary: buildMetricsSummary(metrics) };
}

/**
 * Query per-task metrics breakdown using GROUPED format.
 */
async function queryTaskMetrics(
  telemetryClient: TelemetryRestClient,
  scope: MetricQueryScope,
): Promise<TaskMetrics[]> {
  const taskMap = new Map<string, TaskMetrics>();

  for (const metric of Object.keys(TASK_METRIC_FIELDS)) {
    try {
      const items = await postGroupedMetric(
        telemetryClient,
        metric,
        scope,
        "metric.flink_task.id",
      );
      for (const item of items) {
        const taskId = item["metric.flink_task.id"];
        const value = lastPointValue(item);
        if (!taskId || value === undefined) continue;
        const field = TASK_METRIC_FIELDS[metric];
        if (!field) continue;

        const entry = taskMap.get(taskId) ?? { taskId };
        entry[field] = value;
        taskMap.set(taskId, entry);
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
  telemetryClient: TelemetryRestClient,
  scope: MetricQueryScope,
): Promise<SplitMetrics[]> {
  const splitMap = new Map<string, SplitMetrics>();

  for (const metric of Object.keys(SPLIT_METRIC_FIELDS)) {
    try {
      const items = await postGroupedMetric(
        telemetryClient,
        metric,
        scope,
        "metric.flink_split",
      );
      for (const item of items) {
        const splitName = item["metric.flink_split"];
        const value = lastPointValue(item);
        if (!splitName || value === undefined) continue;
        // Skip Long.MIN_VALUE (no watermark set)
        if (metric.includes("watermark_ms") && value < LONG_MIN_VALUE + 1000000)
          continue;
        const field = SPLIT_METRIC_FIELDS[metric];
        if (!field) continue;

        const entry = splitMap.get(splitName) ?? { splitName };
        entry[field] = value;
        splitMap.set(splitName, entry);
      }
    } catch {
      // Continue with other metrics if one fails
    }
  }

  return Array.from(splitMap.values());
}

type TelemetryRestClient = ReturnType<
  BaseClientManager["getConfluentCloudTelemetryRestClient"]
>;

/**
 * The statement/compute-pool selectors and time window shared by every
 * telemetry query a single getStatementMetrics call issues.
 */
interface MetricQueryScope {
  statementName: string;
  computePoolId: string;
  startTime: Date;
  now: Date;
}

/**
 * Issue POST to the telemetry query endpoint for one metric grouped by the
 * given label, returning the GROUPED data rows (empty array when absent).
 */
async function postGroupedMetric(
  telemetryClient: TelemetryRestClient,
  metric: string,
  scope: MetricQueryScope,
  groupBy: string,
): Promise<NonNullable<GroupedTelemetryResponse["data"]>> {
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
              value: scope.statementName,
            },
            {
              field: "resource.compute_pool.id",
              op: "EQ",
              value: scope.computePoolId,
            },
          ],
        },
        granularity: "PT1M",
        intervals: [
          `${scope.startTime.toISOString()}/${scope.now.toISOString()}`,
        ],
        limit: 1000,
        group_by: [groupBy],
        format: "GROUPED",
      },
    } as never,
  )) as { data?: GroupedTelemetryResponse; error?: unknown };

  const data = response.data as GroupedTelemetryResponse;
  return data?.data ?? [];
}

/**
 * The value of a GROUPED row's most recent point, or undefined when the row
 * carries no points.
 */
function lastPointValue(item: {
  points?: Array<{ value?: number }>;
}): number | undefined {
  const points = item.points;
  return points?.[points.length - 1]?.value;
}

/** SUM / MAX / AVG of one metric's points across all task groups. */
interface AggregatedValue {
  sum: number;
  max: number;
  avg: number;
}

/**
 * Query one statement-level metric and reduce its per-task points into
 * SUM / MAX / AVG, dropping the Long.MIN_VALUE watermark sentinel. Returns
 * undefined when no valid points exist or the query fails.
 */
async function queryAggregatedStatementMetric(
  telemetryClient: TelemetryRestClient,
  metric: string,
  scope: MetricQueryScope,
): Promise<AggregatedValue | undefined> {
  try {
    const items = await postGroupedMetric(
      telemetryClient,
      metric,
      scope,
      "metric.flink_task.id",
    );
    let sum = 0;
    let max = 0;
    let count = 0;
    for (const item of items) {
      const value = lastPointValue(item);
      if (value !== undefined && value > LONG_MIN_VALUE + 1000000) {
        sum += value;
        max = Math.max(max, value);
        count++;
      }
    }
    if (count === 0) return undefined;
    return { sum, max, avg: sum / count };
  } catch {
    return undefined;
  }
}

/**
 * Query every statement-level metric individually (the API allows one
 * aggregation per request), assign each into its target field, and derive
 * watermark lag when both watermarks are present.
 */
async function collectAggregatedMetrics(
  telemetryClient: TelemetryRestClient,
  scope: MetricQueryScope,
): Promise<FlinkStatementMetrics> {
  const metrics: FlinkStatementMetrics = {};

  for (const metric of Object.keys(STATEMENT_METRIC_MAPPINGS)) {
    const aggregated = await queryAggregatedStatementMetric(
      telemetryClient,
      metric,
      scope,
    );
    if (aggregated === undefined) continue;
    const mapping = STATEMENT_METRIC_MAPPINGS[metric];
    if (mapping) metrics[mapping.field] = mapping.aggregate(aggregated);
  }

  if (
    metrics.currentInputWatermarkMs !== undefined &&
    metrics.currentOutputWatermarkMs !== undefined
  ) {
    metrics.watermarkLagMs =
      metrics.currentInputWatermarkMs - metrics.currentOutputWatermarkMs;
  }

  return metrics;
}

// Fields of FlinkStatementMetrics that hold a plain number (excludes the
// string status and the array breakdowns).
type NumericStatementMetricField = {
  [K in keyof FlinkStatementMetrics]-?: NonNullable<
    FlinkStatementMetrics[K]
  > extends number
    ? K
    : never;
}[keyof FlinkStatementMetrics];

/** How one telemetry metric name maps onto an aggregated statement field. */
interface StatementMetricMapping {
  field: NumericStatementMetricField;
  aggregate: (aggregated: AggregatedValue) => number;
}

// Statement-level metrics to query, each mapped to its target field and the
// aggregation appropriate for it: SUM for counters, MAX for bottleneck/
// watermark gauges, AVG for utilization rates. ms/second rates are scaled to
// a 0-100 percentage (1000 ms/s = 100%).
const STATEMENT_METRIC_MAPPINGS: Record<string, StatementMetricMapping> = {
  "io.confluent.flink/num_records_in": {
    field: "numRecordsIn",
    aggregate: (a) => a.sum,
  },
  "io.confluent.flink/num_records_out": {
    field: "numRecordsOut",
    aggregate: (a) => a.sum,
  },
  "io.confluent.flink/pending_records": {
    field: "pendingRecords",
    aggregate: (a) => a.sum,
  },
  "io.confluent.flink/task/backpressure_time_ms_per_second": {
    field: "backpressureTimeMsPerSecond",
    aggregate: (a) => (a.max / 1000) * 100,
  },
  "io.confluent.flink/task/busy_time_ms_per_second": {
    field: "busyTimeMsPerSecond",
    aggregate: (a) => (a.avg / 1000) * 100,
  },
  "io.confluent.flink/task/idle_time_ms_per_second": {
    field: "idleTimeMsPerSecond",
    aggregate: (a) => (a.avg / 1000) * 100,
  },
  "io.confluent.flink/current_input_watermark_milliseconds": {
    field: "currentInputWatermarkMs",
    aggregate: (a) => a.max,
  },
  "io.confluent.flink/current_output_watermark_milliseconds": {
    field: "currentOutputWatermarkMs",
    aggregate: (a) => a.max,
  },
  "io.confluent.flink/num_late_records_in": {
    field: "numLateRecordsIn",
    aggregate: (a) => a.sum,
  },
  "io.confluent.flink/max_input_lateness_milliseconds": {
    field: "maxInputLatenessMs",
    aggregate: (a) => a.max,
  },
  "io.confluent.flink/statement_utilization/current_cfus": {
    field: "currentCfus",
    aggregate: (a) => a.sum,
  },
  "io.confluent.flink/operator/state_size_bytes": {
    field: "stateSizeBytes",
    aggregate: (a) => a.sum,
  },
};

// Non-label numeric fields of TaskMetrics (everything but the taskId key).
type NumericTaskMetricField = Exclude<keyof TaskMetrics, "taskId">;

// Per-task metrics to query, mapped to their target TaskMetrics field.
const TASK_METRIC_FIELDS: Record<string, NumericTaskMetricField> = {
  "io.confluent.flink/task/num_records_in": "numRecordsIn",
  "io.confluent.flink/task/num_records_out": "numRecordsOut",
  "io.confluent.flink/task/num_bytes_in": "numBytesIn",
  "io.confluent.flink/task/num_bytes_out": "numBytesOut",
  "io.confluent.flink/task/backpressure_time_ms_per_second":
    "backpressureTimeMsPerSecond",
  "io.confluent.flink/task/busy_time_ms_per_second": "busyTimeMsPerSecond",
  "io.confluent.flink/task/idle_time_ms_per_second": "idleTimeMsPerSecond",
  "io.confluent.flink/operator/state_size_bytes": "stateSizeBytes",
};

// Non-label numeric fields of SplitMetrics (everything but the splitName key).
type NumericSplitMetricField = Exclude<keyof SplitMetrics, "splitName">;

// Per-split metrics to query, mapped to their target SplitMetrics field.
const SPLIT_METRIC_FIELDS: Record<string, NumericSplitMetricField> = {
  "io.confluent.flink/split/current_watermark_ms": "currentWatermarkMs",
  "io.confluent.flink/split/watermark_active_time_ms_per_second":
    "watermarkActiveTimeMsPerSecond",
  "io.confluent.flink/split/watermark_paused_time_ms_per_second":
    "watermarkPausedTimeMsPerSecond",
  "io.confluent.flink/split/watermark_idle_time_ms_per_second":
    "watermarkIdleTimeMsPerSecond",
};

type IssueSeverity = "low" | "medium" | "high" | "critical";

/** A single diagnostic finding derived from a metrics snapshot. */
interface MetricIssue {
  type: string;
  severity: IssueSeverity;
  description: string;
  suggestion: string;
  value?: number;
}

/**
 * Ordered issue detectors, each inspecting one metric dimension and returning
 * a finding or undefined. analyzeMetrics runs them in order and keeps the hits.
 */
const ISSUE_DETECTORS: Array<
  (metrics: FlinkStatementMetrics) => MetricIssue | undefined
> = [
  detectBackpressure,
  detectLag,
  detectLateData,
  detectLateness,
  detectIdle,
  detectLargeState,
];

// High backpressure indicates a downstream bottleneck. Values are already a
// 0-100 percentage.
function detectBackpressure(
  metrics: FlinkStatementMetrics,
): MetricIssue | undefined {
  const backpressurePercent = metrics.backpressureTimeMsPerSecond;
  if (backpressurePercent === undefined) return undefined;
  if (backpressurePercent > 50) {
    return {
      type: "high_backpressure",
      severity: "high",
      description: `High backpressure detected: ${backpressurePercent.toFixed(1)}% of time spent backpressured.`,
      suggestion:
        "Downstream operators or sinks are slow. Consider: 1) Increasing sink parallelism, 2) Optimizing sink performance, 3) Checking for slow consumers.",
      value: backpressurePercent,
    };
  }
  if (backpressurePercent > 20) {
    return {
      type: "moderate_backpressure",
      severity: "medium",
      description: `Moderate backpressure: ${backpressurePercent.toFixed(1)}% of time spent backpressured.`,
      suggestion: "Some downstream slowdown detected. Monitor for increases.",
      value: backpressurePercent,
    };
  }
  return undefined;
}

// Pending records are the statement's consumer lag.
function detectLag(metrics: FlinkStatementMetrics): MetricIssue | undefined {
  if (metrics.pendingRecords === undefined || metrics.pendingRecords <= 100000)
    return undefined;
  return {
    type: "high_lag",
    severity: metrics.pendingRecords > 1000000 ? "high" : "medium",
    description: `High consumer lag: ${metrics.pendingRecords.toLocaleString()} pending records.`,
    suggestion:
      "Statement is falling behind input rate. Consider: 1) Increasing parallelism, 2) Optimizing query, 3) Adding more CFUs.",
    value: metrics.pendingRecords,
  };
}

// Records that arrived after the watermark.
function detectLateData(
  metrics: FlinkStatementMetrics,
): MetricIssue | undefined {
  if (metrics.numLateRecordsIn === undefined || metrics.numLateRecordsIn <= 0)
    return undefined;
  const severity: IssueSeverity =
    metrics.numLateRecordsIn > 10000
      ? "high"
      : metrics.numLateRecordsIn > 1000
        ? "medium"
        : "low";
  return {
    type: "late_data",
    severity,
    description: `Late records detected: ${metrics.numLateRecordsIn.toLocaleString()} records arrived after watermark.`,
    suggestion:
      "Consider: 1) Increasing watermark delay tolerance, 2) Investigating source timestamp issues, 3) Using allowed lateness in window operations.",
    value: metrics.numLateRecordsIn,
  };
}

// How far behind the watermark the latest records are.
function detectLateness(
  metrics: FlinkStatementMetrics,
): MetricIssue | undefined {
  if (
    metrics.maxInputLatenessMs === undefined ||
    metrics.maxInputLatenessMs <= 60000
  )
    return undefined;
  return {
    type: "high_lateness",
    severity: metrics.maxInputLatenessMs > 300000 ? "high" : "medium",
    description: `High input lateness: max ${(metrics.maxInputLatenessMs / 1000).toFixed(1)}s behind watermark.`,
    suggestion:
      "Some records are arriving significantly late. This may cause data loss in window operations.",
    value: metrics.maxInputLatenessMs,
  };
}

// Mostly-idle with no input often means the source topics are empty. Values
// are already a 0-100 percentage.
function detectIdle(metrics: FlinkStatementMetrics): MetricIssue | undefined {
  const idlePercent = metrics.idleTimeMsPerSecond;
  if (idlePercent === undefined || idlePercent <= 90) return undefined;
  if (metrics.numRecordsIn !== 0) return undefined;
  return {
    type: "no_input_data",
    severity: "medium",
    description: `Statement is mostly idle (${idlePercent.toFixed(1)}%) with no input records.`,
    suggestion:
      "Check if source topics have data. Verify topic names and connectivity.",
    value: idlePercent,
  };
}

// Large state can degrade performance.
function detectLargeState(
  metrics: FlinkStatementMetrics,
): MetricIssue | undefined {
  if (metrics.stateSizeBytes === undefined) return undefined;
  const stateSizeGB = metrics.stateSizeBytes / (1024 * 1024 * 1024);
  if (stateSizeGB <= 10) return undefined;
  return {
    type: "large_state",
    severity: "medium",
    description: `Large state size: ${stateSizeGB.toFixed(2)} GB.`,
    suggestion:
      "Consider: 1) Adding TTL to stateful operations, 2) Using incremental checkpoints, 3) Reviewing deduplication windows.",
    value: metrics.stateSizeBytes,
  };
}

/**
 * A single pipe-delimited line of the headline throughput/utilization figures,
 * or a placeholder when no metrics are populated.
 */
function buildMetricsSummary(metrics: FlinkStatementMetrics): string {
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

  return parts.length > 0 ? parts.join(" | ") : "No metrics data available";
}
