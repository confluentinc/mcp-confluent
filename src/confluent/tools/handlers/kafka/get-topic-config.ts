import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  READ_ONLY,
  ToolCategory,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { resolveKafkaRestArgs } from "@src/confluent/tools/cluster-arg-resolvers.js";
import { kafkaRestWithAuthOrOAuth } from "@src/confluent/tools/connection-predicates.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";

const getTopicConfigArguments = z.object({
  topicName: z
    .string()
    .describe("Name of the topic to get configuration for")
    .nonempty(),
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
      "Confluent Cloud environment ID (env-...) that owns the cluster. Discover via list-environments.",
    ),
});

/**
 * Handler for retrieving Kafka topic configurations through Confluent Cloud REST API.
 * This implementation uses Confluent's REST API endpoints to fetch topic configuration
 * details that aren't directly accessible through the native Kafka admin client API.
 */
export class GetTopicConfigHandler extends BaseToolHandler {
  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const parsed = getTopicConfigArguments.parse(toolArguments);
    const { connId, clientManager } = this.resolveConnection(
      runtime,
      toolArguments,
    );
    const { clusterId, envId } = resolveKafkaRestArgs(parsed, runtime, connId);

    const restClient = await clientManager.getConfluentCloudKafkaRestClient(
      clusterId,
      envId,
    );
    const pathBasedClient = wrapAsPathBasedClient(restClient);

    // First, get topic details
    const { data: topicData, error: topicError } =
      await pathBasedClient[
        `/kafka/v3/clusters/${clusterId}/topics/${parsed.topicName}`
      ].GET();

    if (topicError) {
      return this.createResponse(
        `Failed to retrieve topic details: ${JSON.stringify(topicError)}`,
        true,
      );
    }

    // Then, get topic configurations
    const { data: configData, error: configError } =
      await pathBasedClient[
        `/kafka/v3/clusters/${clusterId}/topics/${parsed.topicName}/configs`
      ].GET();

    if (configError) {
      return this.createResponse(
        `Failed to retrieve topic configuration: ${JSON.stringify(configError)}`,
        true,
      );
    }

    // Combine topic details and configuration into a single response
    const response = {
      topicDetails: topicData,
      topicConfig: configData,
    };

    return this.createResponse(
      `Topic configuration for '${parsed.topicName}':\n${JSON.stringify(response, null, 2)}`,
    );
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.GET_TOPIC_CONFIG,
      description: "Retrieve configuration details for a specific Kafka topic.",
      inputSchema: getTopicConfigArguments.shape,
      annotations: READ_ONLY,
    };
  }
  readonly category = ToolCategory.Kafka;
  readonly predicate = kafkaRestWithAuthOrOAuth;
}
