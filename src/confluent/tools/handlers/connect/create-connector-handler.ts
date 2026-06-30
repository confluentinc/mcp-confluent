import { CallToolResult } from "@src/confluent/schema.js";
import { CREATE_UPDATE, ToolConfig } from "@src/confluent/tools/base-tools.js";
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
  kafkaApiKey: z
    .string()
    .optional()
    .describe(
      "Kafka API key embedded in the connector spec to configure it at runtime. Required when targeting an OAuth connection.",
    ),
  kafkaApiSecret: z
    .string()
    .optional()
    .describe(
      "Kafka API secret embedded in the connector spec to configure it at runtime. Required when targeting an OAuth connection.",
    ),
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
 * The connector spec embeds a Kafka API key/secret that configures the
 * connector at runtime (this is not the credential for the REST call, which
 * rides the OAuth bearer / direct middleware like every other Connect tool).
 * Direct connections fall back to `kafka.auth`; OAuth connections must supply
 * the keypair via the `kafkaApiKey` / `kafkaApiSecret` tool arguments.
 */
export class CreateConnectorHandler extends ConnectToolHandler {
  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const {
      clusterId,
      environmentId,
      connectorName,
      connectorConfig,
      kafkaApiKey: kafkaApiKeyArg,
      kafkaApiSecret: kafkaApiSecretArg,
    } = createConnectorArguments.parse(toolArguments);

    const { conn, clientManager } = this.resolveConnection(
      runtime,
      toolArguments,
    );
    const { environment_id, kafka_cluster_id } =
      this.resolveConnectEnvAndClusterId(conn, environmentId, clusterId);
    // The embedded keypair: explicit args win; on direct connections fall back
    // to kafka.auth. OAuth connections carry no kafka block, so the args are
    // required (resolveParam throws when neither source supplies a value).
    const kafkaApiKey = this.resolveParam(
      kafkaApiKeyArg,
      conn.type === "direct" ? conn.kafka?.auth?.key : undefined,
      "Kafka API Key",
    );
    const kafkaApiSecret = this.resolveParam(
      kafkaApiSecretArg,
      conn.type === "direct" ? conn.kafka?.auth?.secret : undefined,
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
}
