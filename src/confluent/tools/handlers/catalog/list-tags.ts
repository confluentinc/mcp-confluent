import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  READ_ONLY,
  ToolCategory,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { hasCCloudCatalogOrOAuth } from "@src/confluent/tools/connection-predicates.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";

const listTagsArguments = z.object({
  environment_id: z
    .string()
    .optional()
    .describe(
      "Confluent Cloud environment ID (env-...) that owns the Schema Registry. Discover via list-environments.",
    ),
});

export class ListTagsHandler extends BaseToolHandler {
  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const { environment_id } = listTagsArguments.parse(toolArguments);
    const { clientManager } = this.resolveConnection(runtime, toolArguments);
    const pathBasedClient = wrapAsPathBasedClient(
      await clientManager.getSchemaRegistryRestClient(environment_id),
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
      annotations: READ_ONLY,
    };
  }
  readonly category = ToolCategory.Catalog;
  readonly predicate = hasCCloudCatalogOrOAuth;
}
