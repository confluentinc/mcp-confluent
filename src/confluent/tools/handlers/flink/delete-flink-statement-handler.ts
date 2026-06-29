import { CallToolResult } from "@src/confluent/schema.js";
import { DESTRUCTIVE, ToolConfig } from "@src/confluent/tools/base-tools.js";
import { FlinkToolHandler } from "@src/confluent/tools/handlers/flink/flink-tool-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";

const deleteFlinkStatementArguments = z.object({
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
    .describe(
      "The compute pool ID (lfcp-...). Required under OAuth to resolve the regional Flink endpoint.",
    ),
  statementName: z
    .string()
    .regex(
      new RegExp(
        "[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*",
      ),
    )
    .nonempty()
    .max(100)
    .describe(
      "The user provided name of the resource, unique within this environment.",
    ),
});

export class DeleteFlinkStatementHandler extends FlinkToolHandler {
  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const { statementName, environmentId, organizationId, computePoolId } =
      deleteFlinkStatementArguments.parse(toolArguments);
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
    const { response, error } = await pathBasedClient[
      "/sql/v1/organizations/{organization_id}/environments/{environment_id}/statements/{statement_name}"
    ].DELETE({
      params: {
        path: {
          organization_id: organization_id,
          environment_id: environment_id,
          statement_name: statementName,
        },
      },
    });
    if (error) {
      return this.createResponse(
        `Failed to delete Flink SQL statement: ${JSON.stringify(error)}`,
        true,
      );
    }
    return this.createResponse(
      `Flink SQL Statement Deletion Status Code: ${response?.status}`,
    );
  }
  getToolConfig(): ToolConfig {
    return {
      name: ToolName.DELETE_FLINK_STATEMENTS,
      description: "Make a request to delete a statement.",
      inputSchema: deleteFlinkStatementArguments.shape,
      annotations: DESTRUCTIVE,
    };
  }
}
