import type { BaseClientManager } from "@src/confluent/base-client-manager.js";
import { CallToolResult } from "@src/confluent/schema.js";
import { READ_ONLY, ToolConfig } from "@src/confluent/tools/base-tools.js";
import {
  analyzeMetrics,
  getStatementMetrics,
} from "@src/confluent/tools/handlers/flink/diagnostics/metrics-helper.js";
import { FlinkToolHandler } from "@src/confluent/tools/handlers/flink/flink-tool-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";

const detectIssuesArguments = z.object({
  statementName: z
    .string()
    .regex(
      new RegExp(
        "[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*",
      ),
    )
    .nonempty()
    .max(100)
    .describe("The name of the Flink SQL statement to detect issues for."),
  includeMetrics: z
    .boolean()
    .default(true)
    .describe(
      "Include performance metrics analysis (backpressure, lag, etc.) from the Telemetry API.",
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

interface DetectedIssue {
  type: string;
  severity: "low" | "medium" | "high" | "critical";
  description: string;
  suggestion?: string;
}

export class DetectIssuesHandler extends FlinkToolHandler {
  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const {
      statementName,
      environmentId,
      organizationId,
      computePoolId,
      includeMetrics,
    } = detectIssuesArguments.parse(toolArguments);

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

    // Get statement status
    const { data: statementData, error: statusError } = await pathBasedClient[
      "/sql/v1/organizations/{organization_id}/environments/{environment_id}/statements/{statement_name}"
    ].GET({
      params: {
        path: {
          organization_id: organization_id,
          environment_id: environment_id,
          statement_name: statementName,
        },
      },
    });

    if (statusError) {
      return this.createResponse(
        `Failed to get statement status: ${JSON.stringify(statusError)}`,
        true,
      );
    }

    // Get exceptions
    const { data: exceptionsData } = await pathBasedClient[
      "/sql/v1/organizations/{organization_id}/environments/{environment_id}/statements/{statement_name}/exceptions"
    ].GET({
      params: {
        path: {
          organization_id: organization_id,
          environment_id: environment_id,
          statement_name: statementName,
        },
      },
    });

    const phase = statementData?.status?.phase || "UNKNOWN";
    const detail = statementData?.status?.detail || "";
    const exceptions = exceptionsData?.data || [];

    const issues: DetectedIssue[] = [
      ...detectStatusIssues(phase, detail),
      ...detectExceptionIssues(exceptions),
    ];

    const { summary: metricsSummary, issues: metricsIssues } =
      await analyzeStatementMetrics(
        clientManager,
        statementName,
        compute_pool_id,
        includeMetrics,
      );
    issues.push(...metricsIssues);

    if (issues.length === 0 && phase === "RUNNING") {
      const msg = metricsSummary
        ? `No issues detected for statement '${statementName}'. Statement is running normally.\nMetrics: ${metricsSummary}`
        : `No issues detected for statement '${statementName}'. Statement is running normally.`;
      return this.createResponse(msg);
    }

    if (issues.length === 0) {
      return this.createResponse(
        `No issues detected for statement '${statementName}'. Current phase: ${phase}`,
      );
    }

    const response = {
      statementName,
      phase,
      ...(detail && { statusDetail: detail }),
      issueCount: issues.length,
      issues,
      ...(metricsSummary && { metricsSummary }),
    };

    return this.createResponse(
      `Detected ${issues.length} issue(s) for statement '${statementName}':\n${JSON.stringify(response, null, 2)}`,
    );
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.DETECT_FLINK_STATEMENT_ISSUES,
      description:
        "Detect issues for a Flink SQL statement by analyzing status, exceptions, and performance metrics. Identifies problems like failures, backpressure, consumer lag, late data, memory issues, and provides suggested fixes.",
      inputSchema: detectIssuesArguments.shape,
      annotations: READ_ONLY,
    };
  }
}

/**
 * A single Flink statement exception as returned by the exceptions endpoint.
 */
interface StatementException {
  message?: string;
  name?: string;
}

// Phases whose own issue already conveys the failure, so a status-detail
// warning on top would be redundant. STOPPED is deliberately absent — a
// stopped statement with error-like detail still warrants the extra warning.
const DETAIL_WARNING_SUPPRESSING_PHASES = new Set([
  "FAILED",
  "DEGRADED",
  "FAILING",
]);

const STATUS_DETAIL_ERROR_KEYWORDS = [
  "error",
  "fail",
  "issue",
  "problem",
  "attention",
  "contact support",
];

/**
 * Builds the issue for a terminal/non-running phase. Returns undefined for
 * phases that carry no phase-derived issue (e.g. RUNNING, COMPLETED).
 */
function buildPhaseIssue(
  phase: string,
  detail: string,
): DetectedIssue | undefined {
  switch (phase) {
    case "FAILED":
      return {
        type: "statement_failed",
        severity: "critical",
        description: `Statement has failed: ${detail}`,
        suggestion:
          "Check the exceptions for root cause. Consider fixing the SQL or configuration and resubmitting.",
      };
    case "FAILING": {
      const detailSuffix = detail ? ` Detail: ${detail}` : "";
      return {
        type: "statement_failing",
        severity: "high",
        description: `Statement is in a failing state and may stop soon.${detailSuffix}`,
        suggestion:
          "Investigate exceptions immediately. The statement may recover or fail completely.",
      };
    }
    case "DEGRADED":
      return {
        type: "statement_degraded",
        severity: "high",
        description: `Statement is in a degraded state: ${detail || "Performance may be impacted."}`,
        suggestion:
          "This typically indicates an internal system issue. Contact Confluent support if the issue persists.",
      };
    case "STOPPED":
      return {
        type: "statement_stopped",
        severity: "medium",
        description: "Statement has been stopped.",
        suggestion: "Resume the statement if processing should continue.",
      };
    default:
      return undefined;
  }
}

/**
 * Derives issues from the statement's phase and status detail: the phase-based
 * issue (if any) plus a warning when a non-failing phase carries error-like
 * detail text.
 */
function detectStatusIssues(phase: string, detail: string): DetectedIssue[] {
  const issues: DetectedIssue[] = [];

  const phaseIssue = buildPhaseIssue(phase, detail);
  if (phaseIssue) {
    issues.push(phaseIssue);
  }

  if (detail && !DETAIL_WARNING_SUPPRESSING_PHASES.has(phase)) {
    const lowerDetail = detail.toLowerCase();
    const hasErrorKeyword = STATUS_DETAIL_ERROR_KEYWORDS.some((keyword) =>
      lowerDetail.includes(keyword),
    );
    if (hasErrorKeyword) {
      issues.push({
        type: "status_warning",
        severity: "medium",
        description: `Status detail: ${detail}`,
        suggestion: "Review the status message for potential issues.",
      });
    }
  }

  return issues;
}

/**
 * Maps a single exception's message/name to the issues it signals — one per
 * matched pattern, since an exception can trip several.
 */
function classifyException(message: string, name: string): DetectedIssue[] {
  const issues: DetectedIssue[] = [];

  if (message.includes("OutOfMemory") || name.includes("OutOfMemoryError")) {
    issues.push({
      type: "memory_issue",
      severity: "high",
      description: "Out of memory error detected.",
      suggestion:
        "Consider increasing compute pool resources or optimizing the query to reduce state size.",
    });
  }

  if (message.includes("timeout") || message.includes("Timeout")) {
    issues.push({
      type: "timeout",
      severity: "medium",
      description: `Timeout detected: ${message}`,
      suggestion:
        "Check network connectivity and source/sink availability. Consider increasing timeout configurations.",
    });
  }

  if (message.includes("serialization") || message.includes("Serialization")) {
    issues.push({
      type: "serialization_error",
      severity: "high",
      description: `Serialization error: ${message}`,
      suggestion:
        "Check schema compatibility between source and sink. Ensure data types match expected formats.",
    });
  }

  if (
    message.includes("permission") ||
    message.includes("Permission") ||
    message.includes("Access denied")
  ) {
    issues.push({
      type: "permission_error",
      severity: "high",
      description: `Permission error: ${message}`,
      suggestion:
        "Verify API keys and permissions for accessing Kafka topics and other resources.",
    });
  }

  if (message.includes("not found") || message.includes("does not exist")) {
    issues.push({
      type: "resource_not_found",
      severity: "high",
      description: `Resource not found: ${message}`,
      suggestion:
        "Verify that all referenced tables, topics, and databases exist.",
    });
  }

  return issues;
}

/**
 * Derives issues from the exception list: the per-exception pattern matches
 * plus a frequency warning once 5+ exceptions have accumulated.
 */
function detectExceptionIssues(
  exceptions: StatementException[],
): DetectedIssue[] {
  const issues: DetectedIssue[] = [];

  for (const exception of exceptions) {
    issues.push(
      ...classifyException(exception.message || "", exception.name || ""),
    );
  }

  if (exceptions.length >= 5) {
    issues.push({
      type: "frequent_exceptions",
      severity: "medium",
      description: `High exception frequency: ${exceptions.length} exceptions in recent history.`,
      suggestion:
        "The statement is experiencing repeated failures. Investigate the root cause before exceptions accumulate.",
    });
  }

  return issues;
}

/**
 * Queries and analyzes statement metrics when enabled and a compute pool is
 * known. Returns an empty result (no summary, no issues) when metrics are
 * disabled/unavailable, and folds a fetch error into the summary rather than
 * failing the whole request.
 */
async function analyzeStatementMetrics(
  clientManager: BaseClientManager,
  statementName: string,
  computePoolId: string | undefined,
  includeMetrics: boolean,
): Promise<{ summary: string; issues: DetectedIssue[] }> {
  if (!includeMetrics || !computePoolId) {
    return { summary: "", issues: [] };
  }

  const metricsResult = await getStatementMetrics(clientManager, {
    statementName,
    computePoolId,
    intervalMinutes: 5,
  });

  if (metricsResult.success && metricsResult.metrics) {
    const analysis = analyzeMetrics(metricsResult.metrics);
    return { summary: analysis.summary, issues: analysis.issues };
  }

  if (metricsResult.error) {
    return {
      summary: `Metrics unavailable: ${metricsResult.error}`,
      issues: [],
    };
  }

  return { summary: "", issues: [] };
}
