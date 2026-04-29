import { ClientManager } from "@src/confluent/client-manager.js";
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

const addTagToTopicArguments = z.object({
  tagAssignments: z
    .array(
      z.object({
        entityType: z.string().default("kafka_topic"),
        entityName: z
          .string()
          .describe(
            `Qualified name of the entity. If not provided, you can obtain it from using the ${ToolName.SEARCH_TOPICS_BY_NAME} tool. example: "lsrc-g2p81:lkc-xq8k7g:my-flights"`,
          ),
        typeName: z.string().describe("Name of the tag to assign"),
      }),
    )
    .nonempty()
    .describe("Array of tag assignments to create"),
});

export class AddTagToTopicHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const { tagAssignments } = addTagToTopicArguments.parse(toolArguments);

    const pathBasedClient = wrapAsPathBasedClient(
      clientManager.getConfluentCloudSchemaRegistryRestClient(),
    );

    const { data: response, error } = await pathBasedClient[
      "/catalog/v1/entity/tags"
    ].POST({
      body: tagAssignments,
    });

    if (error) {
      return this.createResponse(
        `Failed to assign tag: ${JSON.stringify(error)}`,
        true,
      );
    }
    return this.createResponse(
      `Successfully assigned tag: ${JSON.stringify(response)}`,
    );
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.ADD_TAGS_TO_TOPIC,
      description: "Assign existing tags to Kafka topics in Confluent Cloud.",
      inputSchema: addTagToTopicArguments.shape,
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
