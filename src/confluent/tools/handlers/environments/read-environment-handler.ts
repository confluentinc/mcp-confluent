import { ClientManager } from "@src/confluent/client-manager.js";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { EnvVar } from "@src/env-schema.js";
import env from "@src/env.js";
import { logger } from "@src/logger.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";
import { Environment, environmentSchema } from "./list-environments-handler.js";

const readEnvironmentArguments = z.object({
  baseUrl: z
    .string()
    .describe("The base URL of the Confluent Cloud REST API.")
    .url()
    .default(() => env.CONFLUENT_CLOUD_REST_ENDPOINT ?? "")
    .optional(),
  environmentId: z
    .string()
    .describe("The ID of the environment to retrieve")
    .nonempty(),
});

export class ReadEnvironmentHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const { baseUrl, environmentId } =
      readEnvironmentArguments.parse(toolArguments);

    try {
      if (baseUrl !== undefined && baseUrl !== "") {
        clientManager.setConfluentCloudRestEndpoint(baseUrl);
      }

      const pathBasedClient = wrapAsPathBasedClient(
        clientManager.getConfluentCloudRestClient(),
      );

      const { data: response, error } = await pathBasedClient[
        "/org/v2/environments/{id}"
      ].GET({
        params: {
          path: {
            id: environmentId,
          },
        },
      });

      if (error) {
        logger.error({ error }, "API Error");
        return this.createResponse(
          `Failed to fetch environment: ${JSON.stringify(error)}`,
          true,
          { error },
        );
      }

      try {
        const validatedEnvironment = environmentSchema.parse(
          response,
        ) as Environment;
        const environmentDetails = {
          api_version: validatedEnvironment.api_version,
          kind: validatedEnvironment.kind,
          id: validatedEnvironment.id,
          name: validatedEnvironment.display_name,
          metadata: {
            created_at: validatedEnvironment.metadata.created_at,
            updated_at: validatedEnvironment.metadata.updated_at,
            deleted_at: validatedEnvironment.metadata.deleted_at,
            resource_name: validatedEnvironment.metadata.resource_name,
            self: validatedEnvironment.metadata.self,
          },
          stream_governance_package:
            validatedEnvironment.stream_governance_config?.package,
        };

        const formattedDetails = `
Environment: ${environmentDetails.name}
  API Version: ${environmentDetails.api_version}
  Kind: ${environmentDetails.kind}
  ID: ${environmentDetails.id}
  Resource Name: ${environmentDetails.metadata.resource_name}
  Self Link: ${environmentDetails.metadata.self}
  Created At: ${environmentDetails.metadata.created_at}
  Updated At: ${environmentDetails.metadata.updated_at}${environmentDetails.metadata.deleted_at ? `\n  Deleted At: ${environmentDetails.metadata.deleted_at}` : ""}${environmentDetails.stream_governance_package ? `\n  Stream Governance Package: ${environmentDetails.stream_governance_package}` : ""}
`;

        return this.createResponse(
          `Successfully retrieved environment:\n${formattedDetails}`,
          false,
          { environment: environmentDetails },
        );
      } catch (validationError) {
        logger.error(
          { error: validationError },
          "Environment validation error",
        );
        return this.createResponse(
          `Invalid environment data: ${validationError instanceof Error ? validationError.message : String(validationError)}`,
          true,
          { error: validationError },
        );
      }
    } catch (error) {
      logger.error({ error }, "Error in ReadEnvironmentHandler");
      return this.createResponse(
        `Failed to fetch environment: ${error instanceof Error ? error.message : String(error)}`,
        true,
        { error: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.READ_ENVIRONMENT,
      description: "Get details of a specific environment by ID",
      inputSchema: readEnvironmentArguments.shape,
    };
  }

  getRequiredEnvVars(): EnvVar[] {
    return ["CONFLUENT_CLOUD_API_KEY", "CONFLUENT_CLOUD_API_SECRET"];
  }
}
