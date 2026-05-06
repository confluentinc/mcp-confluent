import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  DESTRUCTIVE,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import {
  connectionIdsWhere,
  hasKafkaBootstrap,
  isOAuth,
} from "@src/confluent/tools/connection-predicates.js";
import {
  disposeIfOAuth,
  resolveKafkaClusterArgs,
} from "@src/confluent/tools/handlers/kafka/cluster-arg-resolvers.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { z } from "zod";

const deleteKafkaTopicsArguments = z.object({
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
      "Confluent Cloud environment ID (env-...) that owns the cluster.",
    ),
  topicNames: z
    .array(z.string().describe("Names of kafka topics to delete"))
    .nonempty(),
});

export class DeleteTopicsHandler extends BaseToolHandler {
  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const parsed = deleteKafkaTopicsArguments.parse(toolArguments);
    const connId = this.enabledConnectionIds(runtime)[0]!;
    const resolved = resolveKafkaClusterArgs(parsed, runtime, connId);
    const clientManager = runtime.clientManagers[connId]!;
    const admin = await clientManager.getKafkaAdminClient(
      resolved.clusterId,
      resolved.envId,
    );
    try {
      // 30s broker-side timeout. See create-topics-handler for rationale.
      await admin.deleteTopics({ timeout: 30_000, topics: parsed.topicNames });
      return this.createResponse(
        `Deleted Kafka topics: ${parsed.topicNames.join(",")}`,
      );
    } finally {
      await disposeIfOAuth(runtime, connId, admin);
    }
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.DELETE_TOPICS,
      description: "Delete the topic with the given names.",
      inputSchema: deleteKafkaTopicsArguments.shape,
      annotations: DESTRUCTIVE,
    };
  }

  enabledConnectionIds(runtime: ServerRuntime): string[] {
    return connectionIdsWhere(
      runtime.config.connections,
      (c) => hasKafkaBootstrap(c) || isOAuth(c),
    );
  }
}
