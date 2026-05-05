import { KafkaJS } from "@confluentinc/kafka-javascript";
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
    const topicNames = parsed.topics.map((t) => t.topic).join(",");
    let success: boolean;
    try {
      // 30s timeout (vs librdkafka's short default) — the broker confirms
      // topic creation in this window. Increasing this further is not the fix
      // for the OAuth first-call stall: that issue is a never-arriving response
      // from the broker, which a longer timeout only delays. Keep this at a
      // reasonable upper bound and diagnose stalls via OAUTH_KAFKA_DEBUG.
      success = await admin.createTopics({
        timeout: 30_000,
        topics: parsed.topics.map(({ topic, numPartitions }) => ({
          topic,
          numPartitions,
        })),
      });
    } catch (err) {
      // KafkaJSAggregateError wraps per-topic KafkaJSCreateTopicError instances;
      // surface each one (topic name + cause) so the agent sees the real reason
      // (auth denial, invalid config, name conflict, etc.) instead of just the
      // aggregate's generic "Topic creation errors" message.
      if (err instanceof KafkaJS.KafkaJSAggregateError) {
        const details = err.errors
          .map((inner) => {
            if (
              inner instanceof KafkaJS.KafkaJSCreateTopicError ||
              inner instanceof KafkaJS.KafkaJSError
            ) {
              const topic =
                inner instanceof KafkaJS.KafkaJSCreateTopicError
                  ? inner.topic
                  : "(unknown topic)";
              return `- ${topic}: ${inner.message}`;
            }
            return `- ${typeof inner === "string" ? inner : String(inner)}`;
          })
          .join("\n");
        return this.createResponse(
          `Failed to create Kafka topics: ${err.message}\n${details}`,
          true,
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      return this.createResponse(
        `Failed to create Kafka topics (${topicNames}): ${message}`,
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
