import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  CREATE_UPDATE,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import {
  connectionIdsWhere,
  hasCCloudCatalogSupport,
} from "@src/confluent/tools/connection-predicates.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";
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
});

export class CreateTopicTagsHandler extends BaseToolHandler {
  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const clientManager = runtime.clientManager;
    const { tags } = createTagsArguments.parse(toolArguments);

    const pathBasedClient = wrapAsPathBasedClient(
      clientManager.getConfluentCloudSchemaRegistryRestClient(),
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

  enabledConnectionIds(runtime: ServerRuntime): string[] {
    return connectionIdsWhere(
      runtime.config.connections,
      hasCCloudCatalogSupport,
    );
  }
}
