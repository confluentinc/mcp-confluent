import type { BaseClientManager } from "@src/confluent/base-client-manager.js";
import { CallToolResult } from "@src/confluent/schema.js";
import { READ_ONLY, ToolConfig } from "@src/confluent/tools/base-tools.js";
import { flinkWithTelemetryOrOAuth } from "@src/confluent/tools/connection-predicates.js";
import { FlinkToolHandler } from "@src/confluent/tools/handlers/flink/flink-tool-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";

const queryProfilerArguments = z.object({
  statementName: z
    .string()
    .regex(
      new RegExp(
        "[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*",
      ),
    )
    .nonempty()
    .max(100)
    .describe("The name of the Flink SQL statement."),
  intervalMinutes: z
    .number()
    .int()
    .min(1)
    .max(60)
    .default(5)
    .describe(
      "Time window in minutes to query metrics for (1-60). Default is 5.",
    ),
  includeAnalysis: z
    .boolean()
    .default(true)
    .describe(
      "Include automated issue detection based on metrics (backpressure, lag, state size, etc.).",
    ),
  organizationId: z
    .string()
    .trim()
    .optional()
    .describe(
      "Confluent Cloud organization ID. Discover via list-organizations.",
    ),
  environmentId: z
    .string()
    .trim()
    .optional()
    .describe(
      "Confluent Cloud environment ID (env-...) that owns the Flink compute pool. Discover via list-environments.",
    ),
  computePoolId: z
    .string()
    .trim()
    .optional()
    .describe(
      "Confluent Cloud Flink compute pool ID (lfcp-...). Discover via list-compute-pools.",
    ),
});

interface TaskGraphOperator {
  num: number;
  operator_id: string;
  operator_name: string;
}

interface TaskGraphTask {
  task_name: string;
  task_id: string;
  input_tasks: Array<{ task_id: string; num: number }>;
  included_operators: TaskGraphOperator[];
}

interface TaskGraph {
  tasks: TaskGraphTask[];
}

interface TaskMetricsData {
  taskId: string;
  taskName: string;
  operators: string[];
  inputTasks: string[];
  // Metrics
  recordsIn?: number;
  recordsOut?: number;
  stateBytes?: number;
  busyPercent?: number;
  idlePercent?: number;
  backpressurePercent?: number;
  inputWatermarkMs?: number;
  outputWatermarkMs?: number;
}

interface StatementSummary {
  recordsIn?: number;
  recordsOut?: number;
  stateBytes?: number;
  inputWatermarkMs?: number;
  outputWatermarkMs?: number;
  cfus?: number;
  pendingRecords?: number;
  numLateRecordsIn?: number;
}

interface DetectedIssue {
  type: string;
  severity: "low" | "medium" | "high" | "critical";
  description: string;
  suggestion: string;
  taskName?: string;
}

// Long.MIN_VALUE indicates no watermark set
const LONG_MIN_VALUE = -9223372036854776000;

export class QueryProfilerHandler extends FlinkToolHandler {
  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const {
      statementName,
      environmentId,
      organizationId,
      computePoolId,
      intervalMinutes,
      includeAnalysis,
    } = queryProfilerArguments.parse(toolArguments);

    const { conn, clientManager } = this.resolveConnection(
      runtime,
      toolArguments,
    );
    const { organization_id, environment_id, compute_pool_id } =
      this.resolveFlinkRouting(conn, {
        organizationId,
        environmentId,
        computePoolId,
      });

    const pathBasedClient = wrapAsPathBasedClient(
      await clientManager.getFlinkRestClient(compute_pool_id, environment_id),
    );

    const { data: taskGraphResponse, error: taskGraphError } =
      await pathBasedClient[
        "/sql/v1/organizations/{organization_id}/environments/{environment_id}/statements/{statement_name}/task-graph"
      ].GET({
        params: {
          path: {
            organization_id,
            environment_id,
            statement_name: statementName,
          },
        },
      });

    if (taskGraphError) {
      return this.createResponse(
        `Failed to get task graph: ${JSON.stringify(taskGraphError)}`,
        true,
      );
    }

    const parsed = parseTaskGraph(
      taskGraphResponse as { Graph?: string } | undefined,
    );
    if ("errorMessage" in parsed) {
      return this.createResponse(parsed.errorMessage, true);
    }

    const taskMetrics = initializeTaskMetrics(parsed.tasks);

    const telemetryClient =
      clientManager.getConfluentCloudTelemetryRestClient();
    const now = new Date();
    const queryContext: MetricQueryContext = {
      statementName,
      computePoolId: compute_pool_id,
      startTime: new Date(now.getTime() - intervalMinutes * 60 * 1000),
      now,
    };

    await collectPerTaskMetrics(telemetryClient, taskMetrics, queryContext);
    const summary = await collectSummaryMetrics(telemetryClient, queryContext);

    const result: Record<string, unknown> = {
      statementName,
      intervalMinutes,
      summary: buildSummaryView(summary),
      tasks: Array.from(taskMetrics.values()).map(buildTaskView),
    };

    if (includeAnalysis) {
      const detectedIssues = detectIssues(taskMetrics, summary);
      result.detectedIssues = detectedIssues;
      result.issueCount = detectedIssues.length;
    }

    return this.createResponse(
      `Query Profiler for '${statementName}':\n${JSON.stringify(result, null, 2)}`,
    );
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.GET_FLINK_STATEMENT_PROFILE,
      description:
        "Get Query Profiler data for a Flink SQL statement. Returns the task graph with human-readable task/operator names, per-task metrics (records in/out, state size, busyness, idleness, backpressure, watermarks), and automated issue detection (backpressure bottlenecks, consumer lag, late data, large state).",
      inputSchema: queryProfilerArguments.shape,
      annotations: READ_ONLY,
    };
  }

  /** Overrides FlinkToolHandler: also requires a telemetry block because profiling fetches metrics from the Telemetry API in addition to the Flink REST API. */
  override readonly predicate = flinkWithTelemetryOrOAuth;
}

/** Discriminated result of decoding the JSON-encoded task graph. */
type TaskGraphParseResult =
  | { tasks: TaskGraphTask[] }
  | { errorMessage: string };

/**
 * Decode the JSON-encoded `Graph` field returned by the task-graph endpoint.
 * Returns a caller-facing message rather than throwing so the handler can
 * distinguish "statement not running" from "malformed payload".
 */
function parseTaskGraph(
  taskGraphResponse: { Graph?: string } | undefined,
): TaskGraphParseResult {
  const graphJson = taskGraphResponse?.Graph;
  if (!graphJson) {
    return {
      errorMessage:
        "Task graph not available. The statement may not be running.",
    };
  }
  try {
    return { tasks: (JSON.parse(graphJson) as TaskGraph).tasks };
  } catch {
    return { errorMessage: "Failed to parse task graph." };
  }
}

/**
 * Seed one TaskMetricsData per task, resolving each input-task id to its
 * human-readable name (falling back to the raw id when unknown).
 */
function initializeTaskMetrics(
  tasks: TaskGraphTask[],
): Map<string, TaskMetricsData> {
  const idToName = new Map<string, string>();
  for (const task of tasks) {
    idToName.set(task.task_id, task.task_name);
  }

  const taskMetrics = new Map<string, TaskMetricsData>();
  for (const task of tasks) {
    taskMetrics.set(task.task_id, {
      taskId: task.task_id,
      taskName: task.task_name,
      operators: task.included_operators.map((op) => op.operator_name),
      inputTasks: task.input_tasks.map(
        (t) => idToName.get(t.task_id) || t.task_id,
      ),
    });
  }
  return taskMetrics;
}

/** Shared parameters for every telemetry metric query in one profile run. */
interface MetricQueryContext {
  statementName: string;
  computePoolId: string;
  startTime: Date;
  now: Date;
}

interface PerTaskMetricSpec {
  metric: string;
  field: keyof TaskMetricsData;
  isPercent?: boolean;
}

interface SummaryMetricSpec {
  metric: string;
  field: keyof StatementSummary;
}

const PER_TASK_METRICS: readonly PerTaskMetricSpec[] = [
  { metric: "io.confluent.flink/task/num_records_in", field: "recordsIn" },
  { metric: "io.confluent.flink/task/num_records_out", field: "recordsOut" },
  {
    metric: "io.confluent.flink/operator/state_size_bytes",
    field: "stateBytes",
  },
  {
    metric: "io.confluent.flink/task/busy_time_ms_per_second",
    field: "busyPercent",
    isPercent: true,
  },
  {
    metric: "io.confluent.flink/task/idle_time_ms_per_second",
    field: "idlePercent",
    isPercent: true,
  },
  {
    metric: "io.confluent.flink/task/backpressure_time_ms_per_second",
    field: "backpressurePercent",
    isPercent: true,
  },
  {
    metric: "io.confluent.flink/operator/current_input_watermark_ms",
    field: "inputWatermarkMs",
  },
  {
    metric: "io.confluent.flink/operator/current_output_watermark_ms",
    field: "outputWatermarkMs",
  },
];

const SUMMARY_METRICS: readonly SummaryMetricSpec[] = [
  { metric: "io.confluent.flink/num_records_in", field: "recordsIn" },
  { metric: "io.confluent.flink/num_records_out", field: "recordsOut" },
  {
    metric: "io.confluent.flink/operator/state_size_bytes",
    field: "stateBytes",
  },
  {
    metric: "io.confluent.flink/current_input_watermark_milliseconds",
    field: "inputWatermarkMs",
  },
  {
    metric: "io.confluent.flink/current_output_watermark_milliseconds",
    field: "outputWatermarkMs",
  },
  {
    metric: "io.confluent.flink/statement_utilization/current_cfus",
    field: "cfus",
  },
  { metric: "io.confluent.flink/pending_records", field: "pendingRecords" },
  {
    metric: "io.confluent.flink/num_late_records_in",
    field: "numLateRecordsIn",
  },
];

type TelemetryClient = ReturnType<
  BaseClientManager["getConfluentCloudTelemetryRestClient"]
>;

interface TelemetryGroup {
  "metric.flink_task.id"?: string;
  points?: Array<{ value?: number }>;
}

/**
 * POST a single-aggregation telemetry query filtered to one statement and
 * compute pool, returning the grouped rows (empty when none). When
 * `groupByTask` is set the rows carry a per-task id for task-level breakdown.
 */
async function queryTelemetryMetric(
  telemetryClient: TelemetryClient,
  metric: string,
  ctx: MetricQueryContext,
  groupByTask: boolean,
): Promise<TelemetryGroup[]> {
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
              value: ctx.statementName,
            },
            {
              field: "resource.compute_pool.id",
              op: "EQ",
              value: ctx.computePoolId,
            },
          ],
        },
        granularity: "PT1M",
        intervals: [`${ctx.startTime.toISOString()}/${ctx.now.toISOString()}`],
        limit: 1000,
        ...(groupByTask ? { group_by: ["metric.flink_task.id"] } : {}),
        format: "GROUPED",
      },
    } as never,
  )) as { data?: { data?: TelemetryGroup[] } };
  return response.data?.data ?? [];
}

/** Query every per-task metric and fold each into `taskMetrics`. */
async function collectPerTaskMetrics(
  telemetryClient: TelemetryClient,
  taskMetrics: Map<string, TaskMetricsData>,
  ctx: MetricQueryContext,
): Promise<void> {
  for (const spec of PER_TASK_METRICS) {
    await collectPerTaskMetric(telemetryClient, taskMetrics, spec, ctx);
  }
}

async function collectPerTaskMetric(
  telemetryClient: TelemetryClient,
  taskMetrics: Map<string, TaskMetricsData>,
  spec: PerTaskMetricSpec,
  ctx: MetricQueryContext,
): Promise<void> {
  try {
    const groups = await queryTelemetryMetric(
      telemetryClient,
      spec.metric,
      ctx,
      true,
    );
    for (const group of groups) {
      applyPerTaskPoint(taskMetrics, spec, group);
    }
  } catch {
    // A single failing metric shouldn't abort the whole profile.
  }
}

/**
 * Fold one grouped telemetry row into its task, honoring the Long.MIN_VALUE
 * "no watermark" sentinel and the ms/second → percent conversion.
 */
function applyPerTaskPoint(
  taskMetrics: Map<string, TaskMetricsData>,
  spec: PerTaskMetricSpec,
  group: TelemetryGroup,
): void {
  const taskId = group["metric.flink_task.id"];
  const value = lastPointValue(group.points);
  if (!taskId || value === undefined || value <= LONG_MIN_VALUE + 1000000) {
    return;
  }
  const task = taskMetrics.get(taskId);
  if (!task) {
    return;
  }
  (task as unknown as Record<string, unknown>)[spec.field] = spec.isPercent
    ? (value / 1000) * 100
    : value;
}

/** Query every statement-level metric (no group_by) into a fresh summary. */
async function collectSummaryMetrics(
  telemetryClient: TelemetryClient,
  ctx: MetricQueryContext,
): Promise<StatementSummary> {
  const summary: StatementSummary = {};
  for (const spec of SUMMARY_METRICS) {
    await collectSummaryMetric(telemetryClient, summary, spec, ctx);
  }
  return summary;
}

async function collectSummaryMetric(
  telemetryClient: TelemetryClient,
  summary: StatementSummary,
  spec: SummaryMetricSpec,
  ctx: MetricQueryContext,
): Promise<void> {
  try {
    const groups = await queryTelemetryMetric(
      telemetryClient,
      spec.metric,
      ctx,
      false,
    );
    const value = lastPointValue(groups[0]?.points);
    if (value === undefined || value <= LONG_MIN_VALUE + 1000000) {
      return;
    }
    (summary as Record<string, unknown>)[spec.field] = value;
  } catch {
    // A single failing metric shouldn't abort the whole profile.
  }
}

/** Value of the last data point, or undefined when there are none. */
function lastPointValue(
  points?: Array<{ value?: number }>,
): number | undefined {
  return points?.at(-1)?.value;
}

/**
 * Shape one task's metrics for the response, formatting percentages and
 * converting watermark epochs to ISO strings.
 */
function buildTaskView(task: TaskMetricsData): Record<string, unknown> {
  return {
    name: task.taskName,
    operators: task.operators,
    metrics: {
      recordsIn: task.recordsIn,
      recordsOut: task.recordsOut,
      stateBytes: task.stateBytes,
      busyPercent: formatPercent(task.busyPercent),
      idlePercent: formatPercent(task.idlePercent),
      backpressurePercent: formatPercent(task.backpressurePercent),
      inputWatermark: epochMsToIso(task.inputWatermarkMs),
      outputWatermark: epochMsToIso(task.outputWatermarkMs),
    },
  };
}

/** Shape the statement-level summary for the response. */
function buildSummaryView(summary: StatementSummary): Record<string, unknown> {
  return {
    recordsIn: summary.recordsIn,
    recordsOut: summary.recordsOut,
    stateBytes: summary.stateBytes,
    stateSizeMB: formatStateSizeMB(summary.stateBytes),
    pendingRecords: summary.pendingRecords,
    inputWatermark: epochMsToIso(summary.inputWatermarkMs),
    outputWatermark: epochMsToIso(summary.outputWatermarkMs),
    cfus: summary.cfus,
  };
}

function formatPercent(value?: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return `${value.toFixed(1)}%`;
}

function formatStateSizeMB(bytes?: number): string | undefined {
  if (bytes === undefined) {
    return undefined;
  }
  return (bytes / (1024 * 1024)).toFixed(2);
}

function epochMsToIso(ms?: number): string | undefined {
  if (ms === undefined) {
    return undefined;
  }
  return new Date(ms).toISOString();
}

/** Run every metric-based issue detector and collect the ones that fired. */
function detectIssues(
  taskMetrics: Map<string, TaskMetricsData>,
  summary: StatementSummary,
): DetectedIssue[] {
  return [
    ...detectBackpressure(taskMetrics),
    detectConsumerLag(summary),
    detectLateData(summary),
    detectLargeState(summary),
    detectNoInputData(taskMetrics, summary),
  ].filter((issue): issue is DetectedIssue => issue !== undefined);
}

/** One issue per task spending >50% of its time backpressured. */
function detectBackpressure(
  taskMetrics: Map<string, TaskMetricsData>,
): DetectedIssue[] {
  const issues: DetectedIssue[] = [];
  for (const task of taskMetrics.values()) {
    if (
      task.backpressurePercent === undefined ||
      task.backpressurePercent <= 50
    ) {
      continue;
    }
    issues.push({
      type: "high_backpressure",
      severity: task.backpressurePercent > 80 ? "high" : "medium",
      description: `Task '${task.taskName}' has ${task.backpressurePercent.toFixed(1)}% backpressure.`,
      suggestion:
        "Downstream operators are slow. Consider increasing parallelism or optimizing sink performance.",
      taskName: task.taskName,
    });
  }
  return issues;
}

function detectConsumerLag(
  summary: StatementSummary,
): DetectedIssue | undefined {
  if (
    summary.pendingRecords === undefined ||
    summary.pendingRecords <= 100000
  ) {
    return undefined;
  }
  return {
    type: "high_consumer_lag",
    severity: summary.pendingRecords > 1000000 ? "high" : "medium",
    description: `High consumer lag: ${summary.pendingRecords.toLocaleString()} pending records.`,
    suggestion:
      "Statement is falling behind input rate. Consider increasing parallelism or CFUs.",
  };
}

function detectLateData(summary: StatementSummary): DetectedIssue | undefined {
  const lateRecords = summary.numLateRecordsIn;
  if (lateRecords === undefined || lateRecords <= 0) {
    return undefined;
  }
  return {
    type: "late_data",
    severity: lateDataSeverity(lateRecords),
    description: `${lateRecords.toLocaleString()} late records detected (arrived after watermark).`,
    suggestion:
      "Consider increasing watermark delay tolerance or investigating source timestamp issues.",
  };
}

function lateDataSeverity(lateRecords: number): DetectedIssue["severity"] {
  if (lateRecords > 10000) {
    return "high";
  }
  if (lateRecords > 1000) {
    return "medium";
  }
  return "low";
}

function detectLargeState(
  summary: StatementSummary,
): DetectedIssue | undefined {
  if (summary.stateBytes === undefined) {
    return undefined;
  }
  const stateSizeGB = summary.stateBytes / (1024 * 1024 * 1024);
  if (stateSizeGB <= 10) {
    return undefined;
  }
  return {
    type: "large_state",
    severity: "medium",
    description: `Large state size: ${stateSizeGB.toFixed(2)} GB.`,
    suggestion:
      "Consider adding TTL to stateful operations or reviewing deduplication windows.",
  };
}

/** Fires when every task is >90% idle and no input records arrived. */
function detectNoInputData(
  taskMetrics: Map<string, TaskMetricsData>,
  summary: StatementSummary,
): DetectedIssue | undefined {
  const allTasksIdle = Array.from(taskMetrics.values()).every(
    (t) => t.idlePercent !== undefined && t.idlePercent > 90,
  );
  if (!allTasksIdle || summary.recordsIn !== 0) {
    return undefined;
  }
  return {
    type: "no_input_data",
    severity: "medium",
    description: "Statement is mostly idle with no input records.",
    suggestion:
      "Check if source topics have data. Verify topic names and connectivity.",
  };
}
