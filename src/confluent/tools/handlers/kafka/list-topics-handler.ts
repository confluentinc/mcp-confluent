import { ClientManager } from "@src/confluent/client-manager.js";
import { CallToolResult, ToolInput } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

const listTopicArgs = z.object({
  // No arguments
});

export class ListTopicsHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const topics = await (await clientManager.getAdminClient()).listTopics();
    return this.createResponse(`Kafka topics: ${topics.join(",")}`);
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.LIST_TOPICS,
      description: "List all topics in the Kafka cluster.",
      inputSchema: zodToJsonSchema(listTopicArgs) as ToolInput,
    };
  }
}
