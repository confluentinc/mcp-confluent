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

const getFlinkExceptionsArguments = z.object({
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

export class GetFlinkExceptionsHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const { statementName, environmentId, organizationId, baseUrl } =
      getFlinkExceptionsArguments.parse(toolArguments);

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
    };
  }

  getRequiredEnvVars(): EnvVar[] {
    return ["FLINK_API_KEY", "FLINK_API_SECRET"];
  }

  isConfluentCloudOnly(): boolean {
    return true;
  }
}
