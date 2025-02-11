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

const removeTagFromEntityArguments = z.object({
  baseUrl: z
    .string()
    .describe("The base URL of the Schema Registry REST API.")
    .url()
    .default(env.SCHEMA_REGISTRY_ENDPOINT ?? "")
    .optional(),
  tagName: z
    .string()
    .describe("Name of the tag to remove from the entity.")
    .nonempty(),
  typeName: z
    .string()
    .describe("Type of the entity")
    .nonempty()
    .default("kafka_topic"),
  qualifiedName: z
    .string()
    .describe(
      `Qualified name of the entity. If not provided, you can obtain it from using the ${ToolName.SEARCH_TOPICS_BY_TAG} tool. example: "lsrc-g2p81:lkc-xq8k7g:my-flights"`,
    )
    .nonempty(),
});

export class RemoveTagFromEntityHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const { tagName, typeName, qualifiedName, baseUrl } =
      removeTagFromEntityArguments.parse(toolArguments);

    if (baseUrl !== undefined && baseUrl !== "") {
      clientManager.setConfluentCloudSchemaRegistryEndpoint(baseUrl);
    }

    const pathBasedClient = wrapAsPathBasedClient(
      clientManager.getConfluentCloudSchemaRegistryRestClient(),
    );

    const { response, error } = await pathBasedClient[
      "/catalog/v1/entity/type/{typeName}/name/{qualifiedName}/tags/{tagName}"
    ].DELETE({
      params: {
        path: {
          typeName,
          qualifiedName,
          tagName,
        },
      },
    });

    if (error) {
      return this.createResponse(
        `Failed to remove tag from entity: ${JSON.stringify(error)}`,
        true,
      );
    }
    return this.createResponse(
      `Successfully removed tag ${tagName} from entity ${qualifiedName} with type ${typeName}. Status: ${response?.status}`,
    );
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.REMOVE_TAG_FROM_ENTITY,
      description: "Remove tag from an entity in Confluent Cloud.",
      inputSchema: removeTagFromEntityArguments.shape,
    };
  }
}
