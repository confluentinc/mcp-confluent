import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  READ_ONLY,
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

const listTopicArgs = z.object({
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
});

export class ListTopicsHandler extends BaseToolHandler {
  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const parsed = listTopicArgs.parse(toolArguments);
    const connId = this.enabledConnectionIds(runtime)[0]!;
    const resolved = resolveKafkaClusterArgs(parsed, runtime, connId);
    const clientManager = runtime.clientManagers[connId]!;
    const admin = await clientManager.getKafkaAdminClient(
      resolved.clusterId,
      resolved.envId,
    );
    const topics = await admin.listTopics();
    return this.createResponse(`Kafka topics: ${topics.join(",")}`);
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.LIST_TOPICS,
      description: "List all topics in the Kafka cluster.",
      inputSchema: listTopicArgs.shape,
      annotations: READ_ONLY,
    };
  }

  enabledConnectionIds(runtime: ServerRuntime): string[] {
    return connectionIdsWhere(
      runtime.config.connections,
      (c) => hasKafkaBootstrap(c) || isOAuth(c),
    );
  }
}
