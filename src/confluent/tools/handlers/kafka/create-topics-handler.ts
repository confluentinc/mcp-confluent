import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  CREATE_UPDATE,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import {
  connectionIdsWhere,
  hasKafkaBootstrap,
  isOAuth,
} from "@src/confluent/tools/connection-predicates.js";
import { resolveKafkaClusterArgs } from "@src/confluent/tools/handlers/kafka/cluster-arg-resolvers.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { z } from "zod";

const createTopicArgs = z.object({
  cluster_id: z
    .string()
    .optional()
    .describe(
      "The Confluent Cloud logical Kafka cluster ID (lkc-...). " +
        "Required under --oauth; under a direct connection it is ignored " +
        "(cluster fixed by configuration). Discover via list-clusters.",
    ),
  environment_id: z
    .string()
    .optional()
    .describe(
      "The Confluent Cloud environment ID (env-...) that owns the cluster. " +
        "Required alongside cluster_id under --oauth. Optional under direct.",
    ),
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
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const parsed = createTopicArgs.parse(toolArguments);
    const connId = this.enabledConnectionIds(runtime)[0]!;
    const resolved = resolveKafkaClusterArgs(parsed, runtime, connId);
    const clientManager = runtime.clientManagers[connId]!;
    const admin = await clientManager.getKafkaAdminClient(
      resolved.clusterId,
      resolved.envId,
    );
    const success = await admin.createTopics({
      topics: parsed.topics.map(({ topic, numPartitions }) => ({
        topic,
        numPartitions,
      })),
    });
    const topicNames = parsed.topics.map((t) => t.topic).join(",");
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
        "Create one or more Kafka topics with an optional partition count.",
      inputSchema: createTopicArgs.shape,
      annotations: CREATE_UPDATE,
    };
  }

  enabledConnectionIds(runtime: ServerRuntime): string[] {
    return connectionIdsWhere(
      runtime.config.connections,
      (c) => hasKafkaBootstrap(c) || isOAuth(c),
    );
  }
}
