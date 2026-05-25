import { CallToolResult } from "@src/confluent/schema.js";
import { READ_ONLY, ToolConfig } from "@src/confluent/tools/base-tools.js";
import {
  ConnectToolHandler,
  connectorByNameArguments,
} from "@src/confluent/tools/handlers/connect/connect-tool-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { wrapAsPathBasedClient } from "openapi-fetch";

export class GetConnectorStatusHandler extends ConnectToolHandler {
  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const clientManager = runtime.clientManager;
    const { clusterId, environmentId, connectorName } =
      connectorByNameArguments.parse(toolArguments);

    const conn = runtime.config.getSoleDirectConnection();
    const { environment_id, kafka_cluster_id } =
      this.resolveConnectEnvAndClusterId(conn, environmentId, clusterId);

    const pathBasedClient = wrapAsPathBasedClient(
      clientManager.getConfluentCloudRestClient(),
    );
    const { data: response, error } = await pathBasedClient[
      "/connect/v1/environments/{environment_id}/clusters/{kafka_cluster_id}/connectors/{connector_name}/status"
    ].GET({
      params: {
        path: {
          connector_name: connectorName,
          environment_id,
          kafka_cluster_id,
        },
        query: { expand: "id" },
      },
    });
    if (error) {
      return this.createResponse(
        `Failed to get status for connector ${connectorName}: ${JSON.stringify(error)}`,
        true,
      );
    }
    // The OpenAPI schema doesn't declare the `id` field, but `?expand=id`
    // augments the response with `{ id: { id: "lcc-...", id_type: "ID" } }`.
    const expanded = response as
      | (typeof response & { id?: { id?: string; id_type?: string } })
      | undefined;
    const lccId = expanded?.id?.id;
    const projection = lccId ? { ...expanded, lccId } : expanded;
    return this.createResponse(
      `Connector Status for ${connectorName}: ${JSON.stringify(projection)}`,
    );
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.GET_CONNECTOR_STATUS,
      description:
        "Get the current state of a connector and its tasks (RUNNING, FAILED, PAUSED, UNASSIGNED) including failure traces if any.",
      inputSchema: connectorByNameArguments.shape,
      annotations: READ_ONLY,
    };
  }
}
