import { CallToolResult } from "@src/confluent/schema.js";
import { CREATE_UPDATE, ToolConfig } from "@src/confluent/tools/base-tools.js";
import {
  ConnectToolHandler,
  connectorByNameArguments,
} from "@src/confluent/tools/handlers/connect/connect-tool-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";

const updateConnectorConfigArguments = connectorByNameArguments.extend({
  connectorConfig: z
    .record(z.string(), z.string())
    .describe(
      "The flat connector configuration map. All values must be strings. " +
        "This replaces the existing configuration; any keys you omit will be removed.",
    ),
});

export class UpdateConnectorConfigHandler extends ConnectToolHandler {
  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const { clusterId, environmentId, connectorName, connectorConfig } =
      updateConnectorConfigArguments.parse(toolArguments);

    const { conn, clientManager } = this.resolveDirectConnection(
      runtime,
      toolArguments,
    );
    const { environment_id, kafka_cluster_id } =
      this.resolveConnectEnvAndClusterId(conn, environmentId, clusterId);

    const pathBasedClient = wrapAsPathBasedClient(
      clientManager.getConfluentCloudRestClient(),
    );
    const updateConfigEndpoint =
      pathBasedClient[
        "/connect/v1/environments/{environment_id}/clusters/{kafka_cluster_id}/connectors/{connector_name}/config"
      ];
    // PUT /config uses replacement semantics: omitted keys are removed, and the
    // server rejects a body missing any field the connector class requires. The
    // generated body type marks `connector.class` / `name` / `kafka.api.key` /
    // `kafka.api.secret` as statically required, but we accept the caller's flat
    // `Record<string, string>` and let CCloud return the validation error if a
    // required key is missing. The cast is scoped to the body field only so path
    // params stay fully type-checked.
    type UpdateConfigBody = NonNullable<
      Parameters<typeof updateConfigEndpoint.PUT>[0]
    >["body"];
    const { data: response, error } = await updateConfigEndpoint.PUT({
      params: {
        path: {
          environment_id,
          kafka_cluster_id,
          connector_name: connectorName,
        },
      },
      body: connectorConfig as unknown as UpdateConfigBody,
    });
    if (error) {
      return this.createResponse(
        `Failed to update connector ${connectorName} config: ${JSON.stringify(error)}`,
        true,
      );
    }
    return this.createResponse(
      `${connectorName} config updated: ${JSON.stringify(response)}`,
    );
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.UPDATE_CONNECTOR_CONFIG,
      description:
        "Update the configuration of an existing connector. Full-replace: omitted keys are removed and the connector is reconfigured (tasks restarted) with the supplied config. Returns the updated connector info.",
      inputSchema: updateConnectorConfigArguments.shape,
      annotations: CREATE_UPDATE,
    };
  }
}
