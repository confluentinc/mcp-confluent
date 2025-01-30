import { ClientManager } from "@src/confluent/client-manager.js";
import { CallToolResult, ToolInput } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import env from "@src/env.js";

const topicTagArgs = z.object({
  baseUrl: z
    .string()
    .describe("The base URL of the Schema Registry REST API.")
    .url()
    .default(env.SCHEMA_REGISTRY_ENDPOINT ?? "")
    .optional(),
  topicTag: z.string().optional().describe("Name of the kafka topic tag"),
});

export class TopicsWithTagsHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const { topicTag, baseUrl } = topicTagArgs.parse(toolArguments);
    if (baseUrl !== undefined && baseUrl !== "") {
      clientManager.setConfluentCloudSchemaRegistryEndpoint(baseUrl);
    }
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
