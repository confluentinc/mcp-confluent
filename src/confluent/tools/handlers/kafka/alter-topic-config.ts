import { ClientManager } from "@src/confluent/client-manager.js";
import { getEnsuredParam } from "@src/confluent/helpers.js";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { EnvVar } from "@src/env-schema.js";
import env from "@src/env.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";

const alterTopicConfigArguments = z.object({
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
});

/**
 * Handler for altering Kafka topic configurations through Confluent Cloud REST API.
 * This implementation serves as a workaround since the native Kafka
 * admin client API does not provide direct methods for altering topic configurations.
 * Instead, we utilize Confluent's REST API endpoints to achieve this functionality.
 */
export class AlterTopicConfigHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const { clusterId, topicName, topicConfigs, validateOnly, baseUrl } =
      alterTopicConfigArguments.parse(toolArguments);
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

    const { data: response, error } = await pathBasedClient[
      `/kafka/v3/clusters/${kafka_cluster_id}/topics/${topicName}/configs:alter`
    ].POST({
      body: {
        data: topicConfigs,
        validate_only: validateOnly,
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
    };
  }

  getRequiredEnvVars(): EnvVar[] {
    return ["KAFKA_API_KEY", "KAFKA_API_SECRET", "BOOTSTRAP_SERVERS"];
  }

  isConfluentCloudOnly(): boolean {
    return true;
  }
}
