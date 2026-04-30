import { getEnsuredParam } from "@src/confluent/helpers.js";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  READ_ONLY,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import {
  connectionIdsWhere,
  hasKafkaRestWithAuth,
} from "@src/confluent/tools/connection-predicates.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";

const getTopicConfigArguments = z.object({
  clusterId: z
    .string()
    .optional()
    .describe("The unique identifier for the Kafka cluster."),
  topicName: z
    .string()
    .describe("Name of the topic to get configuration for")
    .nonempty(),
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
    const clientManager = runtime.clientManager;
    const { clusterId, topicName } =
      getTopicConfigArguments.parse(toolArguments);
    const kafka_cluster_id = getEnsuredParam(
      "KAFKA_CLUSTER_ID",
      "Kafka Cluster ID is required",
      clusterId,
    );

    const pathBasedClient = wrapAsPathBasedClient(
      clientManager.getConfluentCloudKafkaRestClient(),
    );

    // First, get topic details
    const { data: topicData, error: topicError } =
      await pathBasedClient[
        `/kafka/v3/clusters/${kafka_cluster_id}/topics/${topicName}`
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
        `/kafka/v3/clusters/${kafka_cluster_id}/topics/${topicName}/configs`
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
      `Topic configuration for '${topicName}':\n${JSON.stringify(response, null, 2)}`,
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

  enabledConnectionIds(runtime: ServerRuntime): string[] {
    return connectionIdsWhere(runtime.config.connections, hasKafkaRestWithAuth);
  }
}
