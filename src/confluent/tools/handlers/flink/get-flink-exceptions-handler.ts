import { CallToolResult } from "@src/confluent/schema.js";
import { READ_ONLY, ToolConfig } from "@src/confluent/tools/base-tools.js";
import { FlinkToolHandler } from "@src/confluent/tools/handlers/flink/flink-tool-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";

const getFlinkExceptionsArguments = z.object({
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
    .describe("The name of the Flink SQL statement to get exceptions for."),
});

export class GetFlinkExceptionsHandler extends FlinkToolHandler {
  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const clientManager = runtime.clientManager;
    const { statementName, environmentId, organizationId } =
      getFlinkExceptionsArguments.parse(toolArguments);

    const conn = runtime.config.getSoleConnection();
    const organization_id = this.resolveParam(
      organizationId,
      conn.flink?.organization_id,
      "Organization ID",
    );
    const environment_id = this.resolveParam(
      environmentId,
      conn.flink?.environment_id,
      "Environment ID",
    );

    const pathBasedClient = wrapAsPathBasedClient(
      clientManager.getConfluentCloudFlinkRestClient(),
    );

    const { data: response, error } = await pathBasedClient[
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

    if (error) {
      return this.createResponse(
        `Failed to get Flink statement exceptions: ${JSON.stringify(error)}`,
        true,
      );
    }

    const exceptions = response?.data ?? [];
    if (exceptions.length === 0) {
      return this.createResponse(
        `No exceptions found for statement '${statementName}'.`,
      );
    }

    return this.createResponse(
      `Flink Statement Exceptions for '${statementName}':\n${JSON.stringify(exceptions, null, 2)}`,
    );
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.GET_FLINK_STATEMENT_EXCEPTIONS,
      description:
        "Retrieve the 10 most recent exceptions for a Flink SQL statement. Useful for diagnosing failed or failing statements.",
      inputSchema: getFlinkExceptionsArguments.shape,
      annotations: READ_ONLY,
    };
  }
}
