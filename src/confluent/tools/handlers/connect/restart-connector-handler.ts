import { CallToolResult } from "@src/confluent/schema.js";
import { CREATE_UPDATE, ToolConfig } from "@src/confluent/tools/base-tools.js";
import { ConnectToolHandler } from "@src/confluent/tools/handlers/connect/connect-tool-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";

const restartConnectorArguments = z.object({
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
    .describe("The name of the connector to restart."),
  includeTasks: z
    .boolean()
    .optional()
    .describe(
      "If true, also restart the connector's tasks in addition to the connector itself.",
    ),
  onlyFailed: z
    .boolean()
    .optional()
    .describe(
      "If true (combined with includeTasks=true), only restart tasks that are currently in the FAILED state.",
    ),
});

export class RestartConnectorHandler extends ConnectToolHandler {
  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const clientManager = runtime.clientManager;
    const {
      clusterId,
      environmentId,
      connectorName,
      includeTasks,
      onlyFailed,
    } = restartConnectorArguments.parse(toolArguments);

    const conn = runtime.config.getSoleDirectConnection();
    const { environment_id, kafka_cluster_id } =
      this.resolveConnectEnvAndClusterId(conn, environmentId, clusterId);

    const pathBasedClient = wrapAsPathBasedClient(
      clientManager.getConfluentCloudRestClient(),
    );
    // The Confluent Cloud Connect REST API supports `includeTasks` and
    // `onlyFailed` as query params on POST /restart, but the generated
    // OpenAPI types (`restartConnectv1Connector`) declare `query?: never`,
    // so they cannot be passed via the typed client without bypassing the
    // type system. We accept them in the input schema for forward-compat
    // and forward them via params.query with a localized cast — once the
    // upstream openapi.json adds the query parameters and types are
    // regenerated, the cast can be dropped.
    const query: Record<string, boolean> = {};
    if (includeTasks !== undefined) query.includeTasks = includeTasks;
    if (onlyFailed !== undefined) query.onlyFailed = onlyFailed;

    const init = {
      params: {
        path: {
          environment_id,
          kafka_cluster_id,
          connector_name: connectorName,
        },
        ...(Object.keys(query).length > 0 ? { query } : {}),
      },
    };

    const { error } = await pathBasedClient[
      "/connect/v1/environments/{environment_id}/clusters/{kafka_cluster_id}/connectors/{connector_name}/restart"
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ].POST(init as any);
    if (error) {
      return this.createResponse(
        `Failed to restart connector ${connectorName}: ${JSON.stringify(error)}`,
        true,
      );
    }
    return this.createResponse(
      `Restart requested for connector ${connectorName}.`,
    );
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.RESTART_CONNECTOR,
      description:
        "Restart a connector and (optionally) its tasks. Use includeTasks=true to also restart all tasks; combine with onlyFailed=true to only restart failed tasks.",
      inputSchema: restartConnectorArguments.shape,
      annotations: CREATE_UPDATE,
    };
  }
}
