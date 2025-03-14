import { ClientManager } from "@src/confluent/client-manager.js";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import env from "@src/env.js";
import { z } from "zod";
import { Environment, environmentSchema } from "./list-environments-handler.js";

const readEnvironmentArguments = z.object({
  baseUrl: z
    .string()
    .describe("The base URL of the Confluent Cloud REST API.")
    .url()
    .default(env.CONFLUENT_CLOUD_REST_ENDPOINT ?? "")
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
      const url = new URL(`org/v2/environments/${environmentId}`, baseUrl);

      // MCP server log
      await this.createResponse(`Making request to: ${url.toString()}`, false, {
        requestUrl: url.toString(),
      });

      const response = await fetch(url.toString(), {
        headers: {
          Authorization: `Basic ${Buffer.from(`${env.CONFLUENT_CLOUD_API_KEY}:${env.CONFLUENT_CLOUD_API_SECRET}`).toString("base64")}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error("API Error:", {
          status: response.status,
          statusText: response.statusText,
          error: errorText,
        });
        return this.createResponse(
          `Failed to fetch environment using ${url.toString()}: ${response.status} ${response.statusText}\nResponse: ${errorText}`,
          true,
          { status: response.status, statusText: response.statusText },
        );
      }

      let data;
      try {
        const responseText = await response.text();

        try {
          data = JSON.parse(responseText);
        } catch (jsonError) {
          console.error("JSON Parse Error:", jsonError);
          if (
            typeof responseText === "string" &&
            responseText.startsWith("{")
          ) {
            try {
              data = JSON.parse(responseText);
            } catch (secondError: unknown) {
              throw new Error(
                `Failed to parse response as JSON: ${secondError instanceof Error ? secondError.message : String(secondError)}`,
              );
            }
          } else {
            throw new Error(`Invalid JSON response: ${responseText}`);
          }
        }
      } catch (parseError) {
        console.error("Response Parse Error:", parseError);
        return this.createResponse(
          `Failed to parse API response: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
          true,
          {
            parseError:
              parseError instanceof Error
                ? parseError.message
                : String(parseError),
          },
        );
      }

      try {
        const validatedEnvironment = environmentSchema.parse(
          data,
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
        console.error("Environment validation error:", validationError);
        return this.createResponse(
          `Invalid environment data: ${validationError instanceof Error ? validationError.message : String(validationError)}`,
          true,
          { error: validationError },
        );
      }
    } catch (error) {
      console.error("Error in ReadEnvironmentHandler:", error);
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
}
