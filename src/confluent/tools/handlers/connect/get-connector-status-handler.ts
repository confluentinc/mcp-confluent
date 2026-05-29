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

    // CCloud only surfaces the lcc-id via the list endpoint's `expand=id`;
    // the per-connector `/status` endpoint silently ignores `expand`. Use
    // the expansion list and pluck the named entry so a single round-trip
    // yields both status and lccId.
    const pathBasedClient = wrapAsPathBasedClient(
      clientManager.getConfluentCloudRestClient(),
    );
    const { data: response, error } = await pathBasedClient[
      "/connect/v1/environments/{environment_id}/clusters/{kafka_cluster_id}/connectors?expand=info,status,id"
    ].GET({
      params: {
        path: {
          environment_id,
          kafka_cluster_id,
        },
      },
    });
    if (error) {
      return this.createResponse(
        `Failed to get status for connector ${connectorName}: ${JSON.stringify(error)}`,
        true,
      );
    }
    const entry = response?.[connectorName];
    if (!entry?.status) {
      return this.createResponse(
        `Connector ${connectorName} not found in cluster ${kafka_cluster_id}`,
        true,
      );
    }
    const lccId = entry.id?.id;
    const projection = lccId ? { ...entry.status, lccId } : entry.status;
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
