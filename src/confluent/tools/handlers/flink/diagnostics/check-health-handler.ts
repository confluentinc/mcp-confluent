import { CallToolResult } from "@src/confluent/schema.js";
import { READ_ONLY, ToolConfig } from "@src/confluent/tools/base-tools.js";
import { FlinkToolHandler } from "@src/confluent/tools/handlers/flink/flink-tool-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";
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

export class CheckHealthHandler extends FlinkToolHandler {
  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const clientManager = runtime.clientManager;
    const { statementName, environmentId, organizationId } =
      checkHealthArguments.parse(toolArguments);

    const conn = runtime.config.getSoleConnection();
    const organization_id = organizationId || conn.flink?.organization_id;
    if (!organization_id) throw new Error("Organization ID is required");
    const environment_id = environmentId || conn.flink?.environment_id;
    if (!environment_id) throw new Error("Environment ID is required");

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
}
