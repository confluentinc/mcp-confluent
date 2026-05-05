import { CallToolResult } from "@src/confluent/schema.js";
import { READ_ONLY, ToolConfig } from "@src/confluent/tools/base-tools.js";
import { ConnectToolHandler } from "@src/confluent/tools/handlers/connect/connect-tool-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";

const listConnectorArguments = z.object({
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
});

export class ListConnectorsHandler extends ConnectToolHandler {
  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const clientManager = runtime.clientManager;
    const { clusterId, environmentId } =
      listConnectorArguments.parse(toolArguments);
    const conn = runtime.config.getSoleDirectConnection();
    const { environment_id, kafka_cluster_id } =
      this.resolveConnectEnvAndClusterId(conn, environmentId, clusterId);

    const pathBasedClient = wrapAsPathBasedClient(
      clientManager.getConfluentCloudRestClient(),
    );

    // This route returns a bare JSON array of connector name strings, not a paginated envelope.
    // (so `data` will be a string[] if successful)
    const { data: response, error } = await pathBasedClient[
      "/connect/v1/environments/{environment_id}/clusters/{kafka_cluster_id}/connectors"
    ].GET({
      params: {
        path: {
          environment_id: environment_id,
          kafka_cluster_id: kafka_cluster_id,
        },
      },
    });

    if (error) {
      return this.createResponse(
        `Failed to list Confluent Cloud connectors for ${kafka_cluster_id}: ${JSON.stringify(error)}`,
        true,
      );
    }

    return this.createResponse(
      `Active Connectors: ${JSON.stringify(response?.join(","))}`,
    );
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.LIST_CONNECTORS,
      description:
        'Retrieve a list of "names" of the active connectors. You can then make a read request for a specific connector by name.',
      inputSchema: listConnectorArguments.shape,
      annotations: READ_ONLY,
    };
  }
}
