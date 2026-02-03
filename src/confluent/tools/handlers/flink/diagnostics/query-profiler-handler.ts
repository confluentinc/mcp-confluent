import { ClientManager } from "@src/confluent/client-manager.js";
import { getEnsuredParam } from "@src/confluent/helpers.js";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { EnvVar } from "@src/env-schema.js";
import env from "@src/env.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";

const queryProfilerArguments = z.object({
  baseUrl: z
    .string()
    .describe("The base URL of the Flink REST API.")
    .url()
    .default(() => env.FLINK_REST_ENDPOINT ?? "")
    .optional(),
  organizationId: z
    .string()
    .trim()
    .optional()
    .describe("The unique identifier for the organization."),
  environmentId: z
    .string()
    .trim()
    .optional()
    .describe("The unique identifier for the environment."),
  computePoolId: z
    .string()
    .trim()
    .optional()
    .describe("The compute pool ID where the statement runs."),
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

export class QueryProfilerHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const {
      statementName,
      environmentId,
      organizationId,
      computePoolId,
      baseUrl,
      intervalMinutes,
      includeAnalysis,
    } = queryProfilerArguments.parse(toolArguments);

    const organization_id = getEnsuredParam(
      "FLINK_ORG_ID",
      "Organization ID is required",
      organizationId,
    );
    const environment_id = getEnsuredParam(
      "FLINK_ENV_ID",
      "Environment ID is required",
      environmentId,
    );
    const compute_pool_id = getEnsuredParam(
      "FLINK_COMPUTE_POOL_ID",
      "Compute Pool ID is required",
      computePoolId,
    );

    if (baseUrl !== undefined && baseUrl !== "") {
      clientManager.setConfluentCloudFlinkEndpoint(baseUrl);
    }

    // Step 1: Fetch the task graph to get human-readable task/operator names
    const pathBasedClient = wrapAsPathBasedClient(
      clientManager.getConfluentCloudFlinkRestClient(),
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

    // Parse the task graph (Graph field is JSON-encoded string)
    let taskGraph: TaskGraph;
    try {
      const graphJson = (taskGraphResponse as { Graph?: string })?.Graph;
      if (!graphJson) {
        return this.createResponse(
          "Task graph not available. The statement may not be running.",
          true,
        );
      }
      taskGraph = JSON.parse(graphJson) as TaskGraph;
    } catch {
      return this.createResponse("Failed to parse task graph.", true);
    }

    // Build task ID to name mapping
    const taskIdToInfo = new Map<
      string,
      { name: string; operators: string[]; inputs: string[] }
    >();
    for (const task of taskGraph.tasks) {
      taskIdToInfo.set(task.task_id, {
        name: task.task_name,
        operators: task.included_operators.map((op) => op.operator_name),
        inputs: task.input_tasks.map((t) => t.task_id),
      });
    }

    // Step 2: Query telemetry metrics per task
    const telemetryClient =
      clientManager.getConfluentCloudTelemetryRestClient();
    const now = new Date();
    const startTime = new Date(now.getTime() - intervalMinutes * 60 * 1000);

    // Metrics to query per task
    const metricsToQuery = [
      { metric: "io.confluent.flink/task/num_records_in", field: "recordsIn" },
      {
        metric: "io.confluent.flink/task/num_records_out",
        field: "recordsOut",
      },
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

    // Initialize task metrics
    const taskMetrics = new Map<string, TaskMetricsData>();
    for (const [taskId, info] of taskIdToInfo) {
      taskMetrics.set(taskId, {
        taskId,
        taskName: info.name,
        operators: info.operators,
        inputTasks: info.inputs.map((id) => taskIdToInfo.get(id)?.name || id),
      });
    }

    // Query each metric
    for (const { metric, field, isPercent } of metricsToQuery) {
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
                    value: compute_pool_id,
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
        )) as {
          data?: {
            data?: Array<{
              "metric.flink_task.id"?: string;
              points?: Array<{ value?: number }>;
            }>;
          };
        };

        const data = response.data?.data;
        if (data) {
          for (const item of data) {
            const taskId = item["metric.flink_task.id"];
            const value = item.points?.[item.points.length - 1]?.value;
            if (
              taskId &&
              value !== undefined &&
              value > LONG_MIN_VALUE + 1000000
            ) {
              const task = taskMetrics.get(taskId);
              if (task) {
                const finalValue = isPercent ? (value / 1000) * 100 : value;
                (task as unknown as Record<string, unknown>)[field] =
                  finalValue;
              }
            }
          }
        }
      } catch {
        // Continue with other metrics
      }
    }

    // Step 3: Query statement-level summary metrics (no group_by)
    const summary: StatementSummary = {};
    const summaryMetrics = [
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

    for (const { metric, field } of summaryMetrics) {
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
                    value: compute_pool_id,
                  },
                ],
              },
              granularity: "PT1M",
              intervals: [`${startTime.toISOString()}/${now.toISOString()}`],
              limit: 1000,
              format: "GROUPED",
            },
          } as never,
        )) as {
          data?: { data?: Array<{ points?: Array<{ value?: number }> }> };
        };

        const data = response.data?.data;
        if (data && data.length > 0) {
          const firstEntry = data[0];
          const points = firstEntry?.points;
          if (points && points.length > 0) {
            const value = points[points.length - 1]?.value;
            if (value !== undefined && value > LONG_MIN_VALUE + 1000000) {
              (summary as Record<string, unknown>)[field] = value;
            }
          }
        }
      } catch {
        // Continue
      }
    }

    // Build the response
    const tasks = Array.from(taskMetrics.values()).map((task) => ({
      name: task.taskName,
      operators: task.operators,
      metrics: {
        recordsIn: task.recordsIn,
        recordsOut: task.recordsOut,
        stateBytes: task.stateBytes,
        busyPercent:
          task.busyPercent !== undefined
            ? `${task.busyPercent.toFixed(1)}%`
            : undefined,
        idlePercent:
          task.idlePercent !== undefined
            ? `${task.idlePercent.toFixed(1)}%`
            : undefined,
        backpressurePercent:
          task.backpressurePercent !== undefined
            ? `${task.backpressurePercent.toFixed(1)}%`
            : undefined,
        inputWatermark: task.inputWatermarkMs
          ? new Date(task.inputWatermarkMs).toISOString()
          : undefined,
        outputWatermark: task.outputWatermarkMs
          ? new Date(task.outputWatermarkMs).toISOString()
          : undefined,
      },
    }));

    // Analyze metrics for issues if requested
    const detectedIssues: DetectedIssue[] = [];
    if (includeAnalysis) {
      // Check per-task metrics for backpressure issues
      for (const task of taskMetrics.values()) {
        if (
          task.backpressurePercent !== undefined &&
          task.backpressurePercent > 50
        ) {
          detectedIssues.push({
            type: "high_backpressure",
            severity: task.backpressurePercent > 80 ? "high" : "medium",
            description: `Task '${task.taskName}' has ${task.backpressurePercent.toFixed(1)}% backpressure.`,
            suggestion:
              "Downstream operators are slow. Consider increasing parallelism or optimizing sink performance.",
            taskName: task.taskName,
          });
        }
      }

      // Check consumer lag
      if (
        summary.pendingRecords !== undefined &&
        summary.pendingRecords > 100000
      ) {
        detectedIssues.push({
          type: "high_consumer_lag",
          severity: summary.pendingRecords > 1000000 ? "high" : "medium",
          description: `High consumer lag: ${summary.pendingRecords.toLocaleString()} pending records.`,
          suggestion:
            "Statement is falling behind input rate. Consider increasing parallelism or CFUs.",
        });
      }

      // Check late data
      if (
        summary.numLateRecordsIn !== undefined &&
        summary.numLateRecordsIn > 0
      ) {
        const severity =
          summary.numLateRecordsIn > 10000
            ? "high"
            : summary.numLateRecordsIn > 1000
              ? "medium"
              : "low";
        detectedIssues.push({
          type: "late_data",
          severity,
          description: `${summary.numLateRecordsIn.toLocaleString()} late records detected (arrived after watermark).`,
          suggestion:
            "Consider increasing watermark delay tolerance or investigating source timestamp issues.",
        });
      }

      // Check state size
      if (summary.stateBytes !== undefined) {
        const stateSizeGB = summary.stateBytes / (1024 * 1024 * 1024);
        if (stateSizeGB > 10) {
          detectedIssues.push({
            type: "large_state",
            severity: "medium",
            description: `Large state size: ${stateSizeGB.toFixed(2)} GB.`,
            suggestion:
              "Consider adding TTL to stateful operations or reviewing deduplication windows.",
          });
        }
      }

      // Check for idle with no throughput
      const allTasksIdle = Array.from(taskMetrics.values()).every(
        (t) => t.idlePercent !== undefined && t.idlePercent > 90,
      );
      if (allTasksIdle && summary.recordsIn === 0) {
        detectedIssues.push({
          type: "no_input_data",
          severity: "medium",
          description: "Statement is mostly idle with no input records.",
          suggestion:
            "Check if source topics have data. Verify topic names and connectivity.",
        });
      }
    }

    const result: Record<string, unknown> = {
      statementName,
      intervalMinutes,
      summary: {
        recordsIn: summary.recordsIn,
        recordsOut: summary.recordsOut,
        stateBytes: summary.stateBytes,
        stateSizeMB: summary.stateBytes
          ? (summary.stateBytes / (1024 * 1024)).toFixed(2)
          : undefined,
        pendingRecords: summary.pendingRecords,
        inputWatermark: summary.inputWatermarkMs
          ? new Date(summary.inputWatermarkMs).toISOString()
          : undefined,
        outputWatermark: summary.outputWatermarkMs
          ? new Date(summary.outputWatermarkMs).toISOString()
          : undefined,
        cfus: summary.cfus,
      },
      tasks,
    };

    if (includeAnalysis) {
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
    };
  }

  getRequiredEnvVars(): EnvVar[] {
    return [
      "FLINK_API_KEY",
      "FLINK_API_SECRET",
      "CONFLUENT_CLOUD_API_KEY",
      "CONFLUENT_CLOUD_API_SECRET",
    ];
  }

  isConfluentCloudOnly(): boolean {
    return true;
  }
}
