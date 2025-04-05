import { ClientManager } from "@src/confluent/client-manager.js";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import env from "@src/env.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";

const listSchemasArguments = z.object({
  baseUrl: z
    .string()
    .describe("The base URL of the Schema Registry REST API.")
    .url()
    .default(env.SCHEMA_REGISTRY_ENDPOINT ?? "")
    .optional(),
});

export class ListSchemasHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const { baseUrl } = listSchemasArguments.parse(toolArguments);

    if (baseUrl !== undefined && baseUrl !== "") {
      clientManager.setConfluentCloudSchemaRegistryEndpoint(baseUrl);
    }

    const pathBasedClient = wrapAsPathBasedClient(
      clientManager.getConfluentCloudSchemaRegistryRestClient(),
    );

    // First get all subjects
    const { data: response, error: error } = await pathBasedClient[
      "/schemas"
    ].GET({
      query: {
        latestOnly: "true",
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
}
