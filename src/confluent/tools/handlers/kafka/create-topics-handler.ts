import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  CREATE_UPDATE,
  ToolCategory,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import {
  disposeIfOAuth,
  formatKafkaError,
  resolveKafkaClusterArgs,
} from "@src/confluent/tools/cluster-arg-resolvers.js";
import { kafkaBootstrapOrOAuth } from "@src/confluent/tools/connection-predicates.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";
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
  cluster_id: z
    .string()
    .optional()
    .describe(
      "Confluent Cloud logical Kafka cluster ID (lkc-...). Discover via list-clusters.",
    ),
  environment_id: z
    .string()
    .optional()
    .describe(
      "Confluent Cloud environment ID (env-...) that owns the cluster. Discover via list-environments.",
    ),
});

export class CreateTopicsHandler extends BaseToolHandler {
  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const parsed = createTopicArgs.parse(toolArguments);
    const { connId, clientManager } = this.resolveConnection(
      runtime,
      toolArguments,
    );
    const resolved = resolveKafkaClusterArgs(parsed, runtime, connId);
    const admin = await clientManager.getKafkaAdminClient(
      resolved.clusterId,
      resolved.envId,
    );
    const topicNames = parsed.topics.map((t) => t.topic).join(",");
    try {
      let success: boolean;
      try {
        // 30s timeout — the broker confirms topic creation within this window.
        success = await admin.createTopics({
          timeout: 30_000,
          topics: parsed.topics.map(({ topic, numPartitions }) => ({
            topic,
            numPartitions,
          })),
        });
      } catch (err) {
        return this.createResponse(
          `Failed to create Kafka topics (${topicNames}): ${formatKafkaError(err)}`,
          true,
        );
      }
      if (!success) {
        return this.createResponse(
          `Failed to create Kafka topics: ${topicNames}`,
          true,
        );
      }
      return this.createResponse(`Created Kafka topics: ${topicNames}`);
    } finally {
      await disposeIfOAuth(runtime, connId, admin);
    }
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.CREATE_TOPICS,
      description:
        "Create one or more Kafka topics with an optional partition count.",
      inputSchema: createTopicArgs.shape,
      annotations: CREATE_UPDATE,
    };
  }

  readonly category = ToolCategory.Kafka;
  readonly predicate = kafkaBootstrapOrOAuth;
}
