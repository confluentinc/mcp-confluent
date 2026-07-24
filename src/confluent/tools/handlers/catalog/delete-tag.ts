import type { CallToolResult } from "@src/confluent/schema.js";
import type { ToolConfig } from "@src/confluent/tools/base-tools.js";
import {
  BaseToolHandler,
  DESTRUCTIVE,
  ToolCategory,
} from "@src/confluent/tools/base-tools.js";
import { hasCCloudCatalogOrOAuth } from "@src/confluent/tools/connection-predicates.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import type { ServerRuntime } from "@src/server-runtime.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";

const deleteTagArguments = z.object({
  tagName: z.string().describe("Name of the tag to delete").nonempty(),
  environment_id: z
    .string()
    .optional()
    .describe(
      "Confluent Cloud environment ID (env-...) that owns the Schema Registry. Discover via list-environments.",
    ),
});

export class DeleteTagHandler extends BaseToolHandler {
  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const { tagName, environment_id } = deleteTagArguments.parse(toolArguments);
    const { clientManager } = this.resolveConnection(runtime, toolArguments);

    const pathBasedClient = wrapAsPathBasedClient(
      await clientManager.getSchemaRegistryRestClient(environment_id),
    );

    const { response, error } = await pathBasedClient[
      "/catalog/v1/types/tagdefs/{tagName}"
    ].DELETE({
      params: {
        path: {
          tagName: tagName,
        },
      },
    });

    if (error) {
      return this.createResponse(
        `Failed to delete tag: ${JSON.stringify(error)}`,
        true,
      );
    }
    return this.createResponse(
      `Successfully deleted tag: ${tagName}. Status: ${response?.status}`,
    );
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.DELETE_TAG,
      description: "Delete a tag definition from Confluent Cloud.",
      inputSchema: deleteTagArguments.shape,
      annotations: DESTRUCTIVE,
    };
  }
  readonly category = ToolCategory.Catalog;
  readonly predicate = hasCCloudCatalogOrOAuth;
}
