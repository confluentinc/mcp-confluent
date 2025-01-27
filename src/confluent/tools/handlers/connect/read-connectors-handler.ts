import { ClientManager } from "@src/confluent/client-manager.js";
import { getEnsuredParam } from "@src/confluent/helpers.js";
import { CallToolResult, ToolInput } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import env from "@src/env.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ToolName } from "../../tool-name.js";

const readConnectorArguments = z.object({
  baseUrl: z
    .string()
    .trim()
    .describe("The base URL of the Kafka Connect REST API.")
    .url()
    .default(env.CONFLUENT_CLOUD_REST_ENDPOINT ?? "")
    .optional(),
  environmentId: z
    .string()
    .trim()
    .optional()
    .describe(
      "The unique identifier for the environment this resource belongs to.",
    ),
  clusterId: z
    .string()
    .trim()
    .optional()
    .describe("The unique identifier for the Kafka cluster."),
  connectorName: z
    .string()
    .trim()
    .nonempty()
    .describe("The unique name of the connector."),
});

export class ReadConnectorHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const { clusterId, environmentId, connectorName, baseUrl } =
      readConnectorArguments.parse(toolArguments);
    const environment_id = getEnsuredParam(
      "KAFKA_ENV_ID",
      "Environment ID is required",
      environmentId,
    );
    const kafka_cluster_id = getEnsuredParam(
      "KAFKA_CLUSTER_ID",
      "Kafka Cluster ID is required",
      clusterId,
    );
    if (baseUrl !== undefined && baseUrl !== "") {
      clientManager.setConfluentCloudRestEndpoint(baseUrl);
    }

    const pathBasedClient = wrapAsPathBasedClient(
      clientManager.getConfluentCloudRestClient(),
    );
    const { data: response, error } = await pathBasedClient[
      "/connect/v1/environments/{environment_id}/clusters/{kafka_cluster_id}/connectors/{connector_name}"
    ].GET({
      params: {
        path: {
          connector_name: connectorName,
          environment_id: environment_id,
          kafka_cluster_id: kafka_cluster_id,
        },
      },
    });
    if (error) {
      return this.createResponse(
        `Failed to get information about connector ${connectorName}: ${JSON.stringify(error)}`,
      );
    }
    return this.createResponse(
      `Connector Details for ${connectorName}: ${JSON.stringify(response)}`,
    );
  }
  getToolConfig(): ToolConfig {
    return {
      name: ToolName.READ_CONNECTOR,
      description: "Get information about the connector.",
      inputSchema: zodToJsonSchema(readConnectorArguments) as ToolInput,
    };
  }
}
