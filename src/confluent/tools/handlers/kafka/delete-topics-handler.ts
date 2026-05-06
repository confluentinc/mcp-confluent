import { KafkaJS } from "@confluentinc/kafka-javascript";
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
import { resolveKafkaClusterArgs } from "@src/confluent/tools/handlers/kafka/cluster-arg-resolvers.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { z } from "zod";

const deleteKafkaTopicsArguments = z.object({
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
    const topicNames = parsed.topicNames.join(",");
    try {
      // 30s broker-side timeout. See create-topics-handler for rationale.
      await admin.deleteTopics({ timeout: 30_000, topics: parsed.topicNames });
    } catch (err) {
      // KafkaJSAggregateError wraps per-topic failures (auth denial, topic
      // not found, etc.). Surface each one so the agent sees the real reason
      // instead of just the aggregate's generic top-level message.
      if (err instanceof KafkaJS.KafkaJSAggregateError) {
        const details = err.errors
          .map((inner) =>
            inner instanceof KafkaJS.KafkaJSError
              ? `- ${inner.message}`
              : `- ${typeof inner === "string" ? inner : String(inner)}`,
          )
          .join("\n");
        return this.createResponse(
          `Failed to delete Kafka topics: ${err.message}\n${details}`,
          true,
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      return this.createResponse(
        `Failed to delete Kafka topics (${topicNames}): ${message}`,
        true,
      );
    }
    return this.createResponse(`Deleted Kafka topics: ${topicNames}`);
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.DELETE_TOPICS,
      description:
        "Delete the topic with the given names. Under --oauth, requires " +
        "cluster_id and environment_id (call list-clusters first to discover " +
        "them). Under a direct connection, the cluster is fixed by config.",
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
