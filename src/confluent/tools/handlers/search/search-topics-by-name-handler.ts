import { ClientManager } from "@src/confluent/client-manager.js";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  READ_ONLY,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  CCLOUD_SCHEMA_REGISTRY_REQUIRED_ENV_VARS,
  EnvVar,
} from "@src/env-schema.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";

const searchTopicsByNameArguments = z.object({
  topicName: z.string().describe("The topic name to search for"),
});

export class SearchTopicsByNameHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const { topicName } = searchTopicsByNameArguments.parse(toolArguments);
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
      annotations: READ_ONLY,
    };
  }

  getRequiredEnvVars(): readonly EnvVar[] {
    return CCLOUD_SCHEMA_REGISTRY_REQUIRED_ENV_VARS;
  }

  isConfluentCloudOnly(): boolean {
    return true;
  }
}
