import { ClientManager } from "@src/confluent/client-manager.js";
import { getEnsuredParam } from "@src/confluent/helpers.js";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import env from "@src/env.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";

const getTopicConfigArguments = z.object({
  baseUrl: z
    .string()
    .describe("The base URL of the Confluent Cloud Kafka REST API.")
    .url()
    .default(() => env.KAFKA_REST_ENDPOINT ?? "")
    .optional(),
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
    clientManager: ClientManager,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const { clusterId, topicName, baseUrl } =
      getTopicConfigArguments.parse(toolArguments);
    const kafka_cluster_id = getEnsuredParam(
      "KAFKA_CLUSTER_ID",
      "Kafka Cluster ID is required",
      clusterId,
    );

    if (baseUrl !== undefined && baseUrl !== "") {
      clientManager.setConfluentCloudKafkaRestEndpoint(baseUrl);
    }

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
    };
  }
}
