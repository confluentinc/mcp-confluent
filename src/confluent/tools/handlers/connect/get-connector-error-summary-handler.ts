import { ClientManager } from "@src/confluent/client-manager.js";
import { getEnsuredParam } from "@src/confluent/helpers.js";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  READ_ONLY,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  CCLOUD_CONTROL_PLANE_REQUIRED_ENV_VARS,
  EnvVar,
} from "@src/env-schema.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";

const getConnectorErrorSummaryArguments = z.object({
  environmentId: z
    .string()
    .trim()
    .optional()
    .describe(
      "The unique identifier for the environment this resource belongs to.",
    ),
  clusterId: z
    .string()
    .trim()
    .optional()
    .describe("The unique identifier for the Kafka cluster."),
  connectorName: z
    .string()
    .trim()
    .nonempty()
    .describe("The unique name of the connector."),
});

const HEALTHY_TASK_STATES = new Set(["RUNNING", "PROVISIONING", "UNASSIGNED"]);
const TRACE_LINE_LIMIT = 10;
const TRACE_CHAR_LIMIT = 800;

interface CloudStatusTask {
  id: number;
  state: string;
  worker_id: string;
  msg?: string;
  trace?: string;
}

// Schema-declared shape is a strict subset; Confluent Cloud appends diagnostic
// fields (error_summary, validation_errors, etc.) that the OpenAPI spec does
// not promise. Treat all extras as optional.
interface CloudStatusResponse {
  name: string;
  type?: string;
  connector?: {
    state: string;
    worker_id?: string;
    trace?: string;
  };
  tasks?: CloudStatusTask[];
  override_message?: string;
  error_summary?: string | null;
  validation_errors?: string[];
  errors_from_trace?: string[];
  error_details?: unknown;
  is_csfle_error?: boolean;
  validation_error_category_info?: unknown;
  error_recommendation_enabled?: boolean;
  plugin_lifecycle?: string;
}

interface ParsedValidationError {
  field: string;
  message: string;
}

interface ProjectedFailedTask {
  id: number;
  state: string;
  workerId: string;
  msg?: string;
  traceHead?: string;
}

interface ErrorSummaryProjection {
  connectorName: string;
  state: string;
  hasError: boolean;
  summary?: string;
  validationErrors?: ParsedValidationError[];
  errorsFromTrace?: string[];
  errorDetails?: unknown;
  isCsfleError?: boolean;
  pluginLifecycle?: string;
  failedTasks?: ProjectedFailedTask[];
  totalTasks: number;
  connectorTraceHead?: string;
}

function truncateTrace(trace: string | undefined): string | undefined {
  if (!trace) return undefined;
  const trimmed = trace.trimEnd();
  if (!trimmed) return undefined;
  const lines = trimmed.split("\n");
  let head = lines.slice(0, TRACE_LINE_LIMIT).join("\n");
  const truncatedByLines = lines.length > TRACE_LINE_LIMIT;
  let truncatedByChars = false;
  if (head.length > TRACE_CHAR_LIMIT) {
    head = head.slice(0, TRACE_CHAR_LIMIT);
    truncatedByChars = true;
  }
  return truncatedByLines || truncatedByChars
    ? `${head}\n... [truncated]`
    : head;
}

function parseValidationError(raw: string): ParsedValidationError {
  // Split on the FIRST colon only — error messages frequently contain ":".
  const idx = raw.indexOf(":");
  if (idx === -1) return { field: "", message: raw.trim() };
  return {
    field: raw.slice(0, idx).trim(),
    message: raw.slice(idx + 1).trim(),
  };
}

function projectErrorSummary(
  connectorName: string,
  payload: CloudStatusResponse,
): ErrorSummaryProjection {
  const state = payload.connector?.state ?? "UNKNOWN";
  const tasks = payload.tasks ?? [];
  const failedTasks = tasks
    .filter((t) => !HEALTHY_TASK_STATES.has(t.state))
    .map<ProjectedFailedTask>((t) => {
      const projected: ProjectedFailedTask = {
        id: t.id,
        state: t.state,
        workerId: t.worker_id,
      };
      if (t.msg) projected.msg = t.msg;
      const traceHead = truncateTrace(t.trace);
      if (traceHead) projected.traceHead = traceHead;
      return projected;
    });

  const validationErrors = (payload.validation_errors ?? [])
    .map(parseValidationError)
    .filter((e) => e.field || e.message);
  const errorsFromTrace = (payload.errors_from_trace ?? []).filter(Boolean);
  const summary =
    (payload.override_message?.trim() ? payload.override_message.trim() : "") ||
    (payload.error_summary?.trim() ? payload.error_summary.trim() : "");
  const connectorTraceHead =
    state !== "RUNNING" ? truncateTrace(payload.connector?.trace) : undefined;

  const projection: ErrorSummaryProjection = {
    connectorName,
    state,
    hasError:
      state !== "RUNNING" ||
      failedTasks.length > 0 ||
      validationErrors.length > 0,
    totalTasks: tasks.length,
  };

  if (summary) projection.summary = summary;
  if (validationErrors.length > 0)
    projection.validationErrors = validationErrors;
  if (errorsFromTrace.length > 0) projection.errorsFromTrace = errorsFromTrace;
  if (
    payload.error_details !== undefined &&
    payload.error_details !== null &&
    !(
      typeof payload.error_details === "object" &&
      payload.error_details !== null &&
      Object.keys(payload.error_details as Record<string, unknown>).length === 0
    )
  ) {
    projection.errorDetails = payload.error_details;
  }
  if (payload.is_csfle_error) projection.isCsfleError = true;
  if (payload.plugin_lifecycle)
    projection.pluginLifecycle = payload.plugin_lifecycle;
  if (failedTasks.length > 0) projection.failedTasks = failedTasks;
  if (connectorTraceHead) projection.connectorTraceHead = connectorTraceHead;

  return projection;
}

export class GetConnectorErrorSummaryHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const { clusterId, environmentId, connectorName } =
      getConnectorErrorSummaryArguments.parse(toolArguments);
    const environment_id = getEnsuredParam(
      "KAFKA_ENV_ID",
      "Environment ID is required",
      environmentId,
    );
    const kafka_cluster_id = getEnsuredParam(
      "KAFKA_CLUSTER_ID",
      "Kafka Cluster ID is required",
      clusterId,
    );

    const pathBasedClient = wrapAsPathBasedClient(
      clientManager.getConfluentCloudRestClient(),
    );
    const { data: response, error } = await pathBasedClient[
      "/connect/v1/environments/{environment_id}/clusters/{kafka_cluster_id}/connectors/{connector_name}/status"
    ].GET({
      params: {
        path: {
          connector_name: connectorName,
          environment_id: environment_id,
          kafka_cluster_id: kafka_cluster_id,
        },
      },
    });

    if (error) {
      return this.createResponse(
        `Failed to get error summary for connector ${connectorName}: ${JSON.stringify(error)}`,
        true,
      );
    }

    // Cast to access Cloud-extended diagnostic fields not declared in the OpenAPI schema.
    const payload = response as CloudStatusResponse | undefined;
    if (!payload) {
      return this.createResponse(
        `No status payload returned for connector ${connectorName}.`,
        true,
      );
    }

    const projection = projectErrorSummary(connectorName, payload);
    if (!projection.hasError) {
      return this.createResponse(
        `Connector ${connectorName} is ${projection.state}. No errors to summarize.`,
      );
    }

    return this.createResponse(
      `Error summary for ${connectorName}: ${JSON.stringify(projection)}`,
    );
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.GET_CONNECTOR_ERROR_SUMMARY,
      description:
        "Summarize a connector's current errors. Projects Confluent Cloud's /status diagnostics (error_summary, validation_errors, errors_from_trace, override_message, failed task traces) into a compact, agent-friendly form. Returns a one-liner when the connector is healthy.",
      inputSchema: getConnectorErrorSummaryArguments.shape,
      annotations: READ_ONLY,
    };
  }

  getRequiredEnvVars(): readonly EnvVar[] {
    return CCLOUD_CONTROL_PLANE_REQUIRED_ENV_VARS;
  }

  isConfluentCloudOnly(): boolean {
    return true;
  }
}
