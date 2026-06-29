import { CallToolResult } from "@src/confluent/schema.js";
import { CREATE_UPDATE, ToolConfig } from "@src/confluent/tools/base-tools.js";
import {
  ConnectToolHandler,
  connectorByNameArguments,
} from "@src/confluent/tools/handlers/connect/connect-tool-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { wrapAsPathBasedClient } from "openapi-fetch";

export class ResumeConnectorHandler extends ConnectToolHandler {
  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const { clusterId, environmentId, connectorName } =
      connectorByNameArguments.parse(toolArguments);

    const { conn, clientManager } = this.resolveConnection(
      runtime,
      toolArguments,
    );
    const { environment_id, kafka_cluster_id } =
      this.resolveConnectEnvAndClusterId(conn, environmentId, clusterId);

    const pathBasedClient = wrapAsPathBasedClient(
      clientManager.getConfluentCloudRestClient(),
    );
    const { error } = await pathBasedClient[
      "/connect/v1/environments/{environment_id}/clusters/{kafka_cluster_id}/connectors/{connector_name}/resume"
    ].PUT({
      params: {
        path: {
          environment_id,
          kafka_cluster_id,
          connector_name: connectorName,
        },
      },
    });
    if (error) {
      return this.createResponse(
        `Failed to resume connector ${connectorName}: ${JSON.stringify(error)}`,
        true,
      );
    }
    return this.createResponse(
      `Resume requested for connector ${connectorName}.`,
    );
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.RESUME_CONNECTOR,
      description: "Resume a paused connector and its tasks. Idempotent.",
      inputSchema: connectorByNameArguments.shape,
      annotations: CREATE_UPDATE,
    };
  }
}
