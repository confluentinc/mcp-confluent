import { CallToolResult } from "@src/confluent/schema.js";
import { DESTRUCTIVE, ToolConfig } from "@src/confluent/tools/base-tools.js";
import { TableflowToolHandler } from "@src/confluent/tools/handlers/tableflow/tableflow-tool-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";

const deleteTableflowCatalogIntegrationArguments = z.object({
  id: z.string().describe("The unique identifier for the catalog integration."),
  environmentId: z
    .string()
    .trim()
    .optional()
    .describe("Scope the operation to the given environment."),
  clusterId: z
    .string()
    .trim()
    .optional()
    .describe("Scope the operation to the give Kafka cluster."),
});

export class DeleteTableFlowCatalogIntegrationHandler extends TableflowToolHandler {
  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const clientManager = runtime.clientManager;
    const { id, environmentId, clusterId } =
      deleteTableflowCatalogIntegrationArguments.parse(toolArguments);

    const conn = runtime.config.getSoleDirectConnection();
    const { environment_id, kafka_cluster_id } =
      this.resolveTableflowEnvAndClusterId(conn, environmentId, clusterId);

    const pathBasedClient = wrapAsPathBasedClient(
      clientManager.getConfluentCloudTableflowRestClient(),
    );

    const { data: response, error } = await pathBasedClient[
      `/tableflow/v1/catalog-integrations/${id}?environment=${environment_id}&spec.kafka_cluster=${kafka_cluster_id}`
    ].DELETE({
      params: {
        path: {
          id: id,
          environment_id: environment_id,
          kafka_cluster_id: kafka_cluster_id,
        },
      },
    });
    if (error) {
      return this.createResponse(
        `Failed to delete Tableflow catalog integration ${id}: ${JSON.stringify(error)}`,
        true,
      );
    }
    return this.createResponse(
      `Tableflow catalog integration ${id} deleted: ${JSON.stringify(response)}`,
    );
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.DELETE_TABLEFLOW_CATALOG_INTEGRATION,
      description: `Make a request to delete a tableflow catalog integration.`,
      inputSchema: deleteTableflowCatalogIntegrationArguments.shape,
      annotations: DESTRUCTIVE,
    };
  }
}
