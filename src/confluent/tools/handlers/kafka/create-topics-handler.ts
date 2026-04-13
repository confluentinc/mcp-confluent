import { ClientManager } from "@src/confluent/client-manager.js";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  CREATE_UPDATE,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { EnvVar } from "@src/env-schema.js";
import { z } from "zod";

const createTopicArgs = z.object({
  topics: z
    .array(
      z.object({
        topic: z.string().describe("Name of the Kafka topic to create"),
        numPartitions: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Number of partitions for the topic. If not specified, the broker default is used.",
          ),
      }),
    )
    .nonempty(),
});
export class CreateTopicsHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const { topics } = createTopicArgs.parse(toolArguments);
    const success = await (
      await clientManager.getAdminClient()
    ).createTopics({
      topics: topics.map(({ topic, numPartitions }) => ({
        topic,
        numPartitions,
      })),
    });
    const topicNames = topics.map((t) => t.topic).join(",");
    if (!success) {
      return this.createResponse(
        `Failed to create Kafka topics: ${topicNames}`,
        true,
      );
    }
    return this.createResponse(`Created Kafka topics: ${topicNames}`);
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.CREATE_TOPICS,
      description:
        "Create one or more Kafka topics with optional partition count and replication factor.",
      inputSchema: createTopicArgs.shape,
      annotations: CREATE_UPDATE,
    };
  }

  getRequiredEnvVars(): EnvVar[] {
    return ["BOOTSTRAP_SERVERS"];
  }
}
