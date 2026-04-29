import { ClientManager } from "@src/confluent/client-manager.js";
import { getEnsuredParam } from "@src/confluent/helpers.js";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  READ_ONLY,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  CCLOUD_CONTROL_PLANE_REQUIRED_ENV_VARS,
  EnvVar,
} from "@src/env-schema.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";

const getConnectorStatusArguments = z.object({
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
  connectorName: z
    .string()
    .trim()
    .nonempty()
    .describe("The unique name of the connector."),
});

export class GetConnectorStatusHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const { clusterId, environmentId, connectorName } =
      getConnectorStatusArguments.parse(toolArguments);
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
    const { data: response, error } = await pathBasedClient[
      "/connect/v1/environments/{environment_id}/clusters/{kafka_cluster_id}/connectors/{connector_name}/status"
    ].GET({
      params: {
        path: {
          connector_name: connectorName,
          environment_id: environment_id,
          kafka_cluster_id: kafka_cluster_id,
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
      inputSchema: getConnectorStatusArguments.shape,
      annotations: READ_ONLY,
    };
  }

  getRequiredEnvVars(): readonly EnvVar[] {
    return CCLOUD_CONTROL_PLANE_REQUIRED_ENV_VARS;
  }

  isConfluentCloudOnly(): boolean {
    return true;
  }
}
