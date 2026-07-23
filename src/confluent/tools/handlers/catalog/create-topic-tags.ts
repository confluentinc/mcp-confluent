import type { CallToolResult } from "@src/confluent/schema.js";
import type { ToolConfig } from "@src/confluent/tools/base-tools.js";
import {
  BaseToolHandler,
  CREATE_UPDATE,
  ToolCategory,
} from "@src/confluent/tools/base-tools.js";
import { hasCCloudCatalogOrOAuth } from "@src/confluent/tools/connection-predicates.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import type { ServerRuntime } from "@src/server-runtime.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";

const createTagsArguments = z.object({
  tags: z
    .array(
      z.object({
        tagName: z.string().describe("Name of the tag to create").nonempty(),
        description: z
          .string()
          .describe("Description for the tag")
          .default("Tag created via API"),
      }),
    )
    .nonempty()
    .describe("Array of tag definitions to create"),
  environment_id: z
    .string()
    .optional()
    .describe(
      "Confluent Cloud environment ID (env-...) that owns the Schema Registry. Discover via list-environments.",
    ),
});

export class CreateTopicTagsHandler extends BaseToolHandler {
  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const { tags, environment_id } = createTagsArguments.parse(toolArguments);
    const { clientManager } = this.resolveConnection(runtime, toolArguments);

    const pathBasedClient = wrapAsPathBasedClient(
      await clientManager.getSchemaRegistryRestClient(environment_id),
    );

    const tagDefinitions = tags.map((tag) => ({
      entityTypes: ["kafka_topic"],
      name: tag.tagName,
      description: tag.description,
    }));

    const { data: response, error } = await pathBasedClient[
      "/catalog/v1/types/tagdefs"
    ].POST({
      body: tagDefinitions,
    });

    if (error) {
      return this.createResponse(
        `Failed to create tag: ${JSON.stringify(error)}`,
        true,
      );
    }
    return this.createResponse(
      `Successfully created tag: ${JSON.stringify(response)}`,
    );
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.CREATE_TOPIC_TAGS,
      description: "Create new tag definitions in Confluent Cloud.",
      inputSchema: createTagsArguments.shape,
      annotations: CREATE_UPDATE,
    };
  }
  readonly category = ToolCategory.Catalog;
  readonly predicate = hasCCloudCatalogOrOAuth;
}
