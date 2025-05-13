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

const createConnectorArguments = z.object({
  baseUrl: z
    .string()
    .trim()
    .describe("The base URL of the Kafka Connect REST API.")
    .url()
    .default(() => env.CONFLUENT_CLOUD_REST_ENDPOINT ?? "")
    .optional(),
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
    .object({
      // Required fields
      "connector.class": z
        .string()
        .describe(
          "Required for Managed Connector, Ignored for Custom Connector. The connector class name, e.g., BigQuerySink, GcsSink, etc.",
        ),
      // Optional fields
      "confluent.connector.type": z
        .string()
        .default("MANAGED")
        .describe("Required for Custom Connector. The connector type")
        .optional(),

      "confluent.custom.plugin.id": z
        .string()
        .describe(
          "Required for Custom Connector. The custom plugin id of custom connector",
        )
        .optional(),

      "confluent.custom.connection.endpoints": z
        .string()
        .describe(
          "Optional for Custom Connector. Egress endpoint(s) for the connector",
        )
        .optional(),

      "confluent.custom.schema.registry.auto": z
        .string()
        .default("FALSE")
        .describe(
          "Optional for Custom Connector. Automatically add required schema registry properties",
        )
        .optional(),
    })
    // Allow additional string properties
    .catchall(z.string()),
});

export class CreateConnectorHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const {
      clusterId,
      environmentId,
      connectorName,
      connectorConfig,
      baseUrl,
    } = createConnectorArguments.parse(toolArguments);
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
      "/connect/v1/environments/{environment_id}/clusters/{kafka_cluster_id}/connectors"
    ].POST({
      params: {
        path: {
          environment_id: environment_id,
          kafka_cluster_id: kafka_cluster_id,
        },
      },
      body: {
        name: connectorName,
        config: {
          name: connectorName,
          "kafka.api.key": getEnsuredParam(
            "KAFKA_API_KEY",
            "Kafka API Key is required to create the connector. Check if env vars are properly set",
          ),
          "kafka.api.secret": getEnsuredParam(
            "KAFKA_API_SECRET",
            "Kafka API Secret is required to create the connector. Check if env vars are properly set",
          ),
          ...connectorConfig,
        },
      },
    });
    if (error) {
      return this.createResponse(
        `Failed to create connector ${connectorName}: ${JSON.stringify(error)}`,
        true,
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
      inputSchema: createConnectorArguments.shape,
    };
  }

  getRequiredEnvVars(): EnvVar[] {
    return [
      "CONFLUENT_CLOUD_API_KEY",
      "CONFLUENT_CLOUD_API_SECRET",
      "KAFKA_API_KEY",
      "KAFKA_API_SECRET",
    ];
  }
}
