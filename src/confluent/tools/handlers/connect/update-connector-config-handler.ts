import { ClientManager } from "@src/confluent/client-manager.js";
import { getEnsuredParam } from "@src/confluent/helpers.js";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  CREATE_UPDATE,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  CCLOUD_CONTROL_PLANE_REQUIRED_ENV_VARS,
  EnvVar,
} from "@src/env-schema.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";

const updateConnectorConfigArguments = z.object({
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
    .describe("The name of the connector to update."),
  connectorConfig: z
    .record(z.string(), z.string())
    .describe(
      "The flat connector configuration map. All values must be strings. " +
        "This replaces the existing configuration; any keys you omit will be removed.",
    ),
});

export class UpdateConnectorConfigHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const { clusterId, environmentId, connectorName, connectorConfig } =
      updateConnectorConfigArguments.parse(toolArguments);
    const environment_id = getEnsuredParam(
      "KAFKA_ENV_ID",
      "Environment ID is required",
      environmentId,
    );
    const kafka_cluster_id = getEnsuredParam(
      "KAFKA_CLUSTER_ID",
      "Kafka Cluster ID is required",
      clusterId,
    );

    const pathBasedClient = wrapAsPathBasedClient(
      clientManager.getConfluentCloudRestClient(),
    );
    // The PUT /config endpoint accepts the flat configuration map directly,
    // not the {name, config} envelope used by POST /connectors. The generated
    // OpenAPI body type tags `connector.class`, `name`, `kafka.api.key`, and
    // `kafka.api.secret` as required, but in practice an update may legitimately
    // omit any of those — the API only validates the merged config server-side.
    // We forward the caller-provided map verbatim and cast to satisfy the type.
    const { data: response, error } = await pathBasedClient[
      "/connect/v1/environments/{environment_id}/clusters/{kafka_cluster_id}/connectors/{connector_name}/config"
    ].PUT({
      params: {
        path: {
          environment_id: environment_id,
          kafka_cluster_id: kafka_cluster_id,
          connector_name: connectorName,
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body: connectorConfig as any,
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
        "Update the configuration of an existing connector. The connector is reconfigured (and tasks restarted) with the new config. Returns the updated connector info.",
      inputSchema: updateConnectorConfigArguments.shape,
      annotations: CREATE_UPDATE,
    };
  }

  getRequiredEnvVars(): readonly EnvVar[] {
    return CCLOUD_CONTROL_PLANE_REQUIRED_ENV_VARS;
  }

  isConfluentCloudOnly(): boolean {
    return true;
  }
}
