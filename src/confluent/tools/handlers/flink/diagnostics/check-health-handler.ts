import { ClientManager } from "@src/confluent/client-manager.js";
import { getEnsuredParam } from "@src/confluent/helpers.js";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  READ_ONLY,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { EnvVar, FLINK_REQUIRED_ENV_VARS } from "@src/env-schema.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";

const checkHealthArguments = z.object({
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
  statementName: z
    .string()
    .regex(
      new RegExp(
        "[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*",
      ),
    )
    .nonempty()
    .max(100)
    .describe("The name of the Flink SQL statement to check health for."),
});

interface HealthStatus {
  status: "healthy" | "warning" | "critical" | "unknown";
  phase: string;
  message: string;
  details: {
    hasExceptions: boolean;
    exceptionCount: number;
    latestException?: string;
    statementSql?: string;
    computePoolId?: string;
  };
}

export class CheckHealthHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const { statementName, environmentId, organizationId } =
      checkHealthArguments.parse(toolArguments);

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
    const exceptions = exceptionsData?.data || [];
    const latestException = exceptions[0];

    // Determine health status
    const health: HealthStatus = {
      status: "unknown",
      phase,
      message: "",
      details: {
        hasExceptions: exceptions.length > 0,
        exceptionCount: exceptions.length,
        latestException: latestException?.message,
        statementSql: statementData?.spec?.statement,
        computePoolId: statementData?.spec?.compute_pool_id,
      },
    };

    switch (phase) {
      case "RUNNING":
        if (exceptions.length > 0) {
          health.status = "warning";
          health.message = `Statement is running but has ${exceptions.length} recent exception(s). Latest: ${latestException?.message}`;
        } else {
          health.status = "healthy";
          health.message =
            "Statement is running normally with no recent exceptions.";
        }
        break;

      case "COMPLETED":
        health.status = "healthy";
        health.message = "Statement completed successfully.";
        break;

      case "FAILED":
        health.status = "critical";
        health.message = `Statement failed. ${statementData?.status?.detail || latestException?.message || "Check exceptions for details."}`;
        break;

      case "FAILING":
        health.status = "critical";
        health.message = `Statement is failing. ${latestException?.message || "Check exceptions for details."}`;
        break;

      case "STOPPED":
        health.status = "warning";
        health.message = "Statement has been stopped.";
        break;

      case "PENDING":
        health.status = "warning";
        health.message = "Statement is pending execution.";
        break;

      default:
        health.status = "unknown";
        health.message = `Statement is in ${phase} state.`;
    }

    return this.createResponse(
      `Health check for '${statementName}':\n${JSON.stringify(health, null, 2)}`,
    );
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.CHECK_FLINK_STATEMENT_HEALTH,
      description:
        "Perform an aggregate health check for a Flink SQL statement. Returns status (healthy/warning/critical), current phase, recent exceptions, and diagnostic details.",
      inputSchema: checkHealthArguments.shape,
      annotations: READ_ONLY,
    };
  }

  getRequiredEnvVars(): readonly EnvVar[] {
    return FLINK_REQUIRED_ENV_VARS;
  }

  isConfluentCloudOnly(): boolean {
    return true;
  }
}
