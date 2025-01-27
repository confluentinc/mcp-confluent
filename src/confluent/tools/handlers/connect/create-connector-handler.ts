import { ClientManager } from "@src/confluent/client-manager.js";
import { getEnsuredParam } from "@src/confluent/helpers.js";
import { CallToolResult, ToolInput } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  ToolConfig,
  ToolName,
} from "@src/confluent/tools/base-tools.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

const createConnectorArguments = z.object({
  environmentId: z
    .string()
    .optional()
    .describe(
      "The unique identifier for the environment this resource belongs to.",
    ),
  clusterId: z
    .string()
    .optional()
    .describe("The unique identifier for the Kafka cluster."),
  connectorName: z
    .string()
    .nonempty()
    .describe("The name of the connector to create."),
  connectorConfig: z
    .string()
    .nonempty()
    .describe(
      "Configuration parameters for the connector in JSON format. All values should be strings.",
    ),
});

export class CreateConnectorHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const { clusterId, environmentId, connectorName, connectorConfig } =
      createConnectorArguments.parse(toolArguments);
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
    const configJson = JSON.parse(connectorConfig);

    const pathBasedClient = wrapAsPathBasedClient(
      clientManager.getConfluentCloudRestClient(),
    );
    const { data: response, error } = await pathBasedClient[
      "/connect/v1/environments/{environment_id}/clusters/{kafka_cluster_id}/connectors"
    ].POST({
      params: {
        path: {
          environment_id: environment_id,
          kafka_cluster_id: kafka_cluster_id,
        },
        body: {
          name: connectorName,
          config: configJson,
        },
      },
    });
    if (error) {
      return this.createResponse(
        `Failed to create connector ${connectorName}: ${JSON.stringify(error)}`,
      );
    }
    return this.createResponse(
      `${connectorName} created: ${JSON.stringify(response)}`,
    );
  }
  getToolConfig(): ToolConfig {
    return {
      name: ToolName.CREATE_CONNECTOR,
      description:
        "Create a new connector. Returns the new connector information if successful.",
      inputSchema: zodToJsonSchema(createConnectorArguments) as ToolInput,
    };
  }
}
