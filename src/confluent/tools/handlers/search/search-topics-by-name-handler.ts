import type { CallToolResult } from "@src/confluent/schema.js";
import type { ToolConfig } from "@src/confluent/tools/base-tools.js";
import {
  BaseToolHandler,
  READ_ONLY,
  ToolCategory,
} from "@src/confluent/tools/base-tools.js";
import { hasCCloudCatalogOrOAuth } from "@src/confluent/tools/connection-predicates.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import type { ServerRuntime } from "@src/server-runtime.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";

const searchTopicsByNameArguments = z.object({
  topicName: z.string().describe("The topic name to search for"),
  environment_id: z
    .string()
    .optional()
    .describe(
      "Confluent Cloud environment ID (env-...) that owns the Schema Registry. Discover via list-environments.",
    ),
});

export class SearchTopicsByNameHandler extends BaseToolHandler {
  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const { topicName, environment_id } =
      searchTopicsByNameArguments.parse(toolArguments);
    const { clientManager } = this.resolveConnection(runtime, toolArguments);
    const pathBasedClient = wrapAsPathBasedClient(
      await clientManager.getSchemaRegistryRestClient(environment_id),
    );
    const { data: response, error } = await pathBasedClient[
      "/catalog/v1/search/basic?types=kafka_topic&query={topicName}"
    ].GET({
      params: {
        path: {
          topicName: topicName,
        },
      },
    });
    if (error) {
      return this.createResponse(
        `Failed to search for topics by name: ${JSON.stringify(error)}`,
        true,
      );
    }
    return this.createResponse(
      response?.entities
        ?.map((entity) => entity.attributes?.qualifiedName)
        .filter(Boolean)
        .join(", ") || "No matching topics found",
    );
  }
  getToolConfig(): ToolConfig {
    return {
      name: ToolName.SEARCH_TOPICS_BY_NAME,
      description:
        "List all topics in the Kafka cluster matching the specified name.",
      inputSchema: searchTopicsByNameArguments.shape,
      annotations: READ_ONLY,
    };
  }
  readonly category = ToolCategory.Catalog;
  readonly predicate = hasCCloudCatalogOrOAuth;
}
