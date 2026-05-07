import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  CREATE_UPDATE,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { kafkaRestWithAuthOrOAuth } from "@src/confluent/tools/connection-predicates.js";
import { resolveKafkaRestArgs } from "@src/confluent/tools/handlers/kafka/cluster-arg-resolvers.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";

const alterTopicConfigArguments = z.object({
  topicName: z.string().describe("Name of the topic to alter").nonempty(),
  topicConfigs: z
    .array(
      z.object({
        name: z.string().describe("Configuration parameter name").nonempty(),
        value: z.string().describe("Configuration parameter value"),
        operation: z.enum(["SET", "DELETE"]).describe("Operation type"),
      }),
    )
    .nonempty(),
  validateOnly: z.boolean().default(false),
  clusterId: z
    .string()
    .optional()
    .describe(
      "Confluent Cloud logical Kafka cluster ID (lkc-...). Discover via list-clusters.",
    ),
  environmentId: z
    .string()
    .optional()
    .describe(
      "Confluent Cloud environment ID (env-...) that owns the cluster.",
    ),
});

/**
 * Handler for altering Kafka topic configurations through Confluent Cloud REST API.
 * This implementation serves as a workaround since the native Kafka
 * admin client API does not provide direct methods for altering topic configurations.
 * Instead, we utilize Confluent's REST API endpoints to achieve this functionality.
 */
export class AlterTopicConfigHandler extends BaseToolHandler {
  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const parsed = alterTopicConfigArguments.parse(toolArguments);
    const { connId, clientManager } = this.resolveSoleConnection(runtime);
    const { clusterId, envId } = resolveKafkaRestArgs(parsed, runtime, connId);

    const restClient = await clientManager.getConfluentCloudKafkaRestClient(
      clusterId,
      envId,
    );
    const pathBasedClient = wrapAsPathBasedClient(restClient);

    const { data: response, error } = await pathBasedClient[
      `/kafka/v3/clusters/${clusterId}/topics/${parsed.topicName}/configs:alter`
    ].POST({
      body: {
        data: parsed.topicConfigs,
        validate_only: parsed.validateOnly,
      },
    });

    if (error) {
      return this.createResponse(
        `Failed to alter topic config: ${JSON.stringify(error)}`,
        true,
      );
    }

    return this.createResponse(
      `Successfully altered topic config: ${JSON.stringify(response)}`,
    );
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.ALTER_TOPIC_CONFIG,
      description: "Alter topic configuration in Confluent Cloud.",
      inputSchema: alterTopicConfigArguments.shape,
      annotations: CREATE_UPDATE,
    };
  }
  readonly predicate = kafkaRestWithAuthOrOAuth;
}
