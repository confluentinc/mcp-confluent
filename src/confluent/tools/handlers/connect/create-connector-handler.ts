import { CallToolResult } from "@src/confluent/schema.js";
import { CREATE_UPDATE, ToolConfig } from "@src/confluent/tools/base-tools.js";
import {
  connectionIdsWhere,
  hasDirectConfluentCloud,
  hasKafkaAuth,
} from "@src/confluent/tools/connection-predicates.js";
import { ConnectToolHandler } from "@src/confluent/tools/handlers/connect/connect-tool-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";

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

/**
 * Creates a new Confluent Cloud connector.
 * Requires `kafka.auth` in the connection config to supply the Kafka API
 * credentials embedded in the connector body.
 */
export class CreateConnectorHandler extends ConnectToolHandler {
  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const clientManager = runtime.clientManager;
    const { clusterId, environmentId, connectorName, connectorConfig } =
      createConnectorArguments.parse(toolArguments);

    const conn = runtime.config.getSoleDirectConnection();
    const { environment_id, kafka_cluster_id } =
      this.resolveConnectEnvAndClusterId(conn, environmentId, clusterId);
    // hasKafkaAuth in enabledConnectionIds() guarantees auth is present here.
    const kafkaApiKey = this.resolveParam(
      undefined,
      conn.kafka?.auth?.key,
      "Kafka API Key",
    );
    const kafkaApiSecret = this.resolveParam(
      undefined,
      conn.kafka?.auth?.secret,
      "Kafka API Secret",
    );

    const pathBasedClient = wrapAsPathBasedClient(
      clientManager.getConfluentCloudRestClient(),
    );
    const { data: response, error } = await pathBasedClient[
      "/connect/v1/environments/{environment_id}/clusters/{kafka_cluster_id}/connectors"
    ].POST({
      params: {
        path: {
          environment_id,
          kafka_cluster_id,
        },
      },
      body: {
        name: connectorName,
        config: {
          name: connectorName,
          "kafka.api.key": kafkaApiKey,
          "kafka.api.secret": kafkaApiSecret,
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
      annotations: CREATE_UPDATE,
    };
  }

  enabledConnectionIds(runtime: ServerRuntime): string[] {
    return connectionIdsWhere(
      runtime.config.connections,
      (conn) => hasDirectConfluentCloud(conn) && hasKafkaAuth(conn),
    );
  }
}
