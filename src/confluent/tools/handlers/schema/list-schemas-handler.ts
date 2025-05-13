import { ClientManager } from "@src/confluent/client-manager.js";
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

const listSchemasArguments = z.object({
  baseUrl: z
    .string()
    .describe("The base URL of the Schema Registry REST API.")
    .url()
    .default(() => env.SCHEMA_REGISTRY_ENDPOINT ?? "")
    .optional(),
  latestOnly: z
    .boolean()
    .describe("If true, only return the latest version of each schema.")
    .default(true)
    .optional(),
  subjectPrefix: z
    .string()
    .describe("The prefix of the subject to list schemas for.")
    .optional(),
  deleted: z.string().describe("List deleted schemas.").optional(),
});

export class ListSchemasHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const { baseUrl, latestOnly, subjectPrefix, deleted } =
      listSchemasArguments.parse(toolArguments);

    if (baseUrl !== undefined && baseUrl !== "") {
      clientManager.setConfluentCloudSchemaRegistryEndpoint(baseUrl);
    }

    const pathBasedClient = wrapAsPathBasedClient(
      clientManager.getConfluentCloudSchemaRegistryRestClient(),
    );

    // First get all schemas
    const { data: response, error: error } = await pathBasedClient[
      "/schemas"
    ].GET({
      query: {
        ...(latestOnly ? { latestOnly: true } : {}),
        ...(subjectPrefix ? { subjectPrefix: subjectPrefix } : {}),
        ...(deleted ? { deleted: true } : {}),
      },
    });

    if (error) {
      return this.createResponse(
        `Failed to list schemas: ${JSON.stringify(error)}`,
        true,
      );
    }

    return this.createResponse(`${JSON.stringify(response)}`);
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.LIST_SCHEMAS,
      description: "List all schemas in the Schema Registry.",
      inputSchema: listSchemasArguments.shape,
    };
  }

  getRequiredEnvVars(): EnvVar[] {
    return ["SCHEMA_REGISTRY_API_KEY", "SCHEMA_REGISTRY_API_SECRET"];
  }
}
