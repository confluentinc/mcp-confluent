import { ClientManager } from "@src/confluent/client-manager.js";
import { getEnsuredParam } from "@src/confluent/helpers.js";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import {
  getStatementMetrics,
  analyzeMetrics,
} from "@src/confluent/tools/handlers/flink/diagnostics/metrics-helper.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { EnvVar } from "@src/env-schema.js";
import env from "@src/env.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";

const detectIssuesArguments = z.object({
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
    .describe("The compute pool ID. Required for metrics analysis."),
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
      "Include performance metrics analysis (backpressure, lag, etc.). Requires CONFLUENT_CLOUD_API_KEY.",
    ),
});

interface DetectedIssue {
  type: string;
  severity: "low" | "medium" | "high" | "critical";
  description: string;
  suggestion?: string;
}

export class DetectIssuesHandler extends BaseToolHandler {
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
      includeMetrics,
    } = detectIssuesArguments.parse(toolArguments);

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
    const compute_pool_id = computePoolId || env.FLINK_COMPUTE_POOL_ID;

    if (baseUrl !== undefined && baseUrl !== "") {
      clientManager.setConfluentCloudFlinkEndpoint(baseUrl);
    }

    const pathBasedClient = wrapAsPathBasedClient(
      clientManager.getConfluentCloudFlinkRestClient(),
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
    const issues: DetectedIssue[] = [];

    // Detect issues based on state
    if (phase === "FAILED") {
      issues.push({
        type: "statement_failed",
        severity: "critical",
        description: `Statement has failed: ${detail}`,
        suggestion:
          "Check the exceptions for root cause. Consider fixing the SQL or configuration and resubmitting.",
      });
    }

    if (phase === "FAILING") {
      issues.push({
        type: "statement_failing",
        severity: "high",
        description: `Statement is in a failing state and may stop soon.${detail ? ` Detail: ${detail}` : ""}`,
        suggestion:
          "Investigate exceptions immediately. The statement may recover or fail completely.",
      });
    }

    if (phase === "DEGRADED") {
      issues.push({
        type: "statement_degraded",
        severity: "high",
        description: `Statement is in a degraded state: ${detail || "Performance may be impacted."}`,
        suggestion:
          "This typically indicates an internal system issue. Contact Confluent support if the issue persists.",
      });
    }

    if (phase === "STOPPED") {
      issues.push({
        type: "statement_stopped",
        severity: "medium",
        description: "Statement has been stopped.",
        suggestion: "Resume the statement if processing should continue.",
      });
    }

    // Check for error details even when phase is RUNNING or other states
    if (
      detail &&
      phase !== "FAILED" &&
      phase !== "DEGRADED" &&
      phase !== "FAILING"
    ) {
      // Only report if detail contains error-like keywords
      const errorKeywords = [
        "error",
        "fail",
        "issue",
        "problem",
        "attention",
        "contact support",
      ];
      const hasErrorKeyword = errorKeywords.some((keyword) =>
        detail.toLowerCase().includes(keyword),
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

    // Analyze exceptions for patterns
    for (const exception of exceptions) {
      const message = exception.message || "";
      const name = exception.name || "";

      // Common error patterns
      if (
        message.includes("OutOfMemory") ||
        name.includes("OutOfMemoryError")
      ) {
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

      if (
        message.includes("serialization") ||
        message.includes("Serialization")
      ) {
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
    }

    // Check for exception frequency (multiple exceptions indicate ongoing issues)
    if (exceptions.length >= 5) {
      issues.push({
        type: "frequent_exceptions",
        severity: "medium",
        description: `High exception frequency: ${exceptions.length} exceptions in recent history.`,
        suggestion:
          "The statement is experiencing repeated failures. Investigate the root cause before exceptions accumulate.",
      });
    }

    // Query and analyze metrics if enabled and compute pool is available
    let metricsSummary = "";
    if (includeMetrics && compute_pool_id) {
      const metricsResult = await getStatementMetrics(clientManager, {
        statementName,
        computePoolId: compute_pool_id,
        intervalMinutes: 5,
      });

      if (metricsResult.success && metricsResult.metrics) {
        const analysis = analyzeMetrics(metricsResult.metrics);
        metricsSummary = analysis.summary;

        // Add metrics-based issues
        for (const metricsIssue of analysis.issues) {
          issues.push(metricsIssue);
        }
      } else if (metricsResult.error) {
        // Include metrics error in response but don't fail the whole request
        metricsSummary = `Metrics unavailable: ${metricsResult.error}`;
      }
    }

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
    };
  }

  getRequiredEnvVars(): EnvVar[] {
    return ["FLINK_API_KEY", "FLINK_API_SECRET"];
  }

  isConfluentCloudOnly(): boolean {
    return true;
  }
}
