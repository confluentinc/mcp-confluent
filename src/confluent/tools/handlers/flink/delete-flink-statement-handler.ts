import { ClientManager } from "@src/confluent/client-manager.js";
import { getEnsuredParam } from "@src/confluent/helpers.js";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import env from "@src/env.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";

const deleteFlinkStatementArguments = z.object({
  baseUrl: z
    .string()
    .trim()
    .describe("The base URL of the Flink REST API.")
    .url()
    .default(env.FLINK_REST_ENDPOINT ?? "")
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

export class DeleteFlinkStatementHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const { statementName, environmentId, organizationId, baseUrl } =
      deleteFlinkStatementArguments.parse(toolArguments);
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

    if (baseUrl !== undefined && baseUrl !== "") {
      clientManager.setConfluentCloudFlinkEndpoint(baseUrl);
    }
    const pathBasedClient = wrapAsPathBasedClient(
      clientManager.getConfluentCloudFlinkRestClient(),
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
    };
  }
}
