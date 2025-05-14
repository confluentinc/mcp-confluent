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

const searchTopicsByNameArguments = z.object({
  baseUrl: z
    .string()
    .describe("The base URL of the Schema Registry REST API.")
    .url()
    .default(() => env.SCHEMA_REGISTRY_ENDPOINT ?? "")
    .optional(),
  topicName: z.string().describe("The topic name to search for"),
});

export class SearchTopicsByNameHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const { topicName, baseUrl } =
      searchTopicsByNameArguments.parse(toolArguments);
    if (baseUrl !== undefined && baseUrl !== "") {
      clientManager.setConfluentCloudSchemaRegistryEndpoint(baseUrl);
    }
    const pathBasedClient = wrapAsPathBasedClient(
      clientManager.getConfluentCloudSchemaRegistryRestClient(),
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
    };
  }

  getRequiredEnvVars(): EnvVar[] {
    return ["SCHEMA_REGISTRY_API_KEY", "SCHEMA_REGISTRY_API_SECRET"];
  }

  isConfluentCloudOnly(): boolean {
    return true;
  }
}
