import { ClientManager } from "@src/confluent/client-manager.js";
import { CallToolResult, ToolInput } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  ToolConfig,
  ToolName,
} from "@src/confluent/tools/base-tools.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { wrapAsPathBasedClient } from "openapi-fetch";

const topicTagArgs = z.object({
  topicTag: z.string().optional().describe("Name of the kafka topic tag"),
});

export class TopicsWithTagsHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const { topicTag } = topicTagArgs.parse(toolArguments);
    const pathBasedClient = wrapAsPathBasedClient(
      clientManager.getConfluentCloudSchemaRegistryRestClient(),
    );
    const topics = await pathBasedClient[
      "/catalog/v1/search/basic?types=kafka_topic&tag={topicTag}"
    ].GET({
      params: {
        path: {
          topicTag: topicTag,
        },
      },
    });
    return this.createResponse(
      `Kafka topics:, ${JSON.stringify(topics?.data)}`,
    );
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.LIST_TOPICS_WITH_A_SPECIFIED_TAG,
      description:
        "List all topics in the Kafka cluster with the specified tag.",
      inputSchema: zodToJsonSchema(topicTagArgs) as ToolInput,
    };
  }
}
