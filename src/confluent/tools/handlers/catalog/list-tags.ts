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

const listTagsArguments = z.object({
  baseUrl: z
    .string()
    .describe("The base URL of the Schema Registry REST API.")
    .url()
    .default(() => env.SCHEMA_REGISTRY_ENDPOINT ?? "")
    .optional(),
});

export class ListTagsHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const { baseUrl } = listTagsArguments.parse(toolArguments);

    if (baseUrl !== undefined && baseUrl !== "") {
      clientManager.setConfluentCloudSchemaRegistryEndpoint(baseUrl);
    }

    const pathBasedClient = wrapAsPathBasedClient(
      clientManager.getConfluentCloudSchemaRegistryRestClient(),
    );

    const { data: response, error } =
      await pathBasedClient["/catalog/v1/types/tagdefs"].GET();
    if (error) {
      return this.createResponse(
        `Failed to list tags: ${JSON.stringify(error)}`,
        true,
      );
    }
    return this.createResponse(
      `Successfully retrieved tags: ${JSON.stringify(response)}`,
    );
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.LIST_TAGS,
      description:
        "Retrieve all tags with definitions from Confluent Cloud Schema Registry.",
      inputSchema: listTagsArguments.shape,
    };
  }

  getRequiredEnvVars(): EnvVar[] {
    return ["SCHEMA_REGISTRY_API_KEY", "SCHEMA_REGISTRY_API_SECRET"];
  }

  isConfluentCloudOnly(): boolean {
    return true;
  }
}
