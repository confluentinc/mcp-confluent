import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  READ_ONLY,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import {
  connectionIdsWhere,
  hasKafka,
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
    let parsed: z.infer<typeof listTopicArgs>;
    try {
      parsed = listTopicArgs.parse(toolArguments);
    } catch (err) {
      return this.createResponse(
        err instanceof Error ? err.message : String(err),
        true,
      );
    }

    const enabledIds = this.enabledConnectionIds(runtime);
    const connId = enabledIds[0];
    if (connId === undefined) {
      return this.createResponse(
        "list-topics is not enabled for any connection.",
        true,
      );
    }

    let resolved: { clusterId: string | undefined; envId: string | undefined };
    try {
      resolved = resolveKafkaClusterArgs(parsed, runtime, connId);
    } catch (err) {
      return this.createResponse(
        err instanceof Error ? err.message : String(err),
        true,
      );
    }

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
      (c) => hasKafka(c) || isOAuth(c),
    );
  }
}
