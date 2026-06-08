import { CallToolResult } from "@src/confluent/schema.js";
import { READ_ONLY, ToolConfig } from "@src/confluent/tools/base-tools.js";
import {
  ConnectToolHandler,
  connectorByNameArguments,
} from "@src/confluent/tools/handlers/connect/connect-tool-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { wrapAsPathBasedClient } from "openapi-fetch";

export class GetConnectorTasksHandler extends ConnectToolHandler {
  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const { clusterId, environmentId, connectorName } =
      connectorByNameArguments.parse(toolArguments);

    const { conn, clientManager } = this.resolveDirectConnection(
      runtime,
      toolArguments,
    );
    const { environment_id, kafka_cluster_id } =
      this.resolveConnectEnvAndClusterId(conn, environmentId, clusterId);

    const pathBasedClient = wrapAsPathBasedClient(
      clientManager.getConfluentCloudRestClient(),
    );
    const { data: response, error } = await pathBasedClient[
      "/connect/v1/environments/{environment_id}/clusters/{kafka_cluster_id}/connectors/{connector_name}/tasks"
    ].GET({
      params: {
        path: {
          connector_name: connectorName,
          environment_id,
          kafka_cluster_id,
        },
      },
    });
    if (error) {
      return this.createResponse(
        `Failed to get tasks for connector ${connectorName}: ${JSON.stringify(error)}`,
        true,
      );
    }
    return this.createResponse(
      `Connector Tasks for ${connectorName}: ${JSON.stringify(response)}`,
    );
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.GET_CONNECTOR_TASKS,
      description:
        "List the tasks of a connector along with their configurations.",
      inputSchema: connectorByNameArguments.shape,
      annotations: READ_ONLY,
    };
  }
}
