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

const searchTopicsByTagArguments = z.object({
  topicTag: z.string().optional().describe("The tag we wish to search for"),
  limit: z
    .number()
    .max(500)
    .describe("The maximum number of topics to return.")
    .default(100),
  offset: z
    .number()
    .describe("The offset to start the search from. Used for pagination.")
    .default(0),
});

export class SearchTopicsByTagHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const { topicTag, limit, offset } =
      searchTopicsByTagArguments.parse(toolArguments);
    const pathBasedClient = wrapAsPathBasedClient(
      clientManager.getConfluentCloudSchemaRegistryRestClient(),
    );
    const { data: response, error } = await pathBasedClient[
      "/catalog/v1/search/basic?types=kafka_topic&tag={topicTag}&limit={limit}&offset={offset}"
    ].GET({
      params: {
        path: {
          topicTag: topicTag,
          limit: limit,
          offset: offset,
        },
      },
    });
    if (error) {
      return this.createResponse(
        `Failed to search for topics by tag: ${JSON.stringify(error)}`,
        true,
      );
    }
    return this.createResponse(`${JSON.stringify(response)}`);
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.SEARCH_TOPICS_BY_TAG,
      description:
        "List all topics in the Kafka cluster with the specified tag.",
      inputSchema: searchTopicsByTagArguments.shape,
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
