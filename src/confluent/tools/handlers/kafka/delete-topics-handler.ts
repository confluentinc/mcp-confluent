import { ClientManager } from "@src/confluent/client-manager.js";
import { CallToolResult, ToolInput } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

const deleteKafkaTopicsArguments = z.object({
  topicNames: z
    .array(z.string().describe("Names of kafka topics to delete"))
    .nonempty(),
});
export class DeleteTopicsHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const { topicNames } = deleteKafkaTopicsArguments.parse(toolArguments);
    await (
      await clientManager.getAdminClient()
    ).deleteTopics({ topics: topicNames });
    return this.createResponse(`Deleted Kafka topics: ${topicNames.join(",")}`);
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.DELETE_TOPICS,
      description: "Delete the topic with the given names.",
      inputSchema: zodToJsonSchema(deleteKafkaTopicsArguments) as ToolInput,
    };
  }
}
