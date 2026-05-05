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

const getConnectorErrorRecommendationsArguments = z.object({
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

interface RecommendationsProjection {
  connectorName: string;
  recommendations: string[];
  eventId?: string;
  engineError?: unknown;
}

export class GetConnectorErrorRecommendationsHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const { clusterId, environmentId, connectorName } =
      getConnectorErrorRecommendationsArguments.parse(toolArguments);
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
      "/connect/v1/environments/{environment_id}/clusters/{kafka_cluster_id}/connectors/{connector_name}/error-recommendations"
    ].GET({
      params: {
        path: {
          connector_name: connectorName,
          environment_id: environment_id,
          kafka_cluster_id: kafka_cluster_id,
        },
      },
    });

    if (error) {
      // Cloud returns 400 with this body when the connector has no captured stack trace
      // (e.g. healthy connectors and connectors that failed only at config validation).
      // Treat that as "no recommendations" rather than a tool error.
      const message =
        typeof error === "object" &&
        error !== null &&
        "error" in error &&
        typeof (error as { error?: unknown }).error === "object" &&
        (error as { error?: { message?: unknown } }).error !== null
          ? (error as { error: { message?: unknown } }).error.message
          : undefined;
      if (
        typeof message === "string" &&
        message.startsWith(
          "could not generate recommendations as error stack trace is not available",
        )
      ) {
        return this.createResponse(
          `No error recommendations available for connector ${connectorName}.`,
        );
      }
      return this.createResponse(
        `Failed to get error recommendations for connector ${connectorName}: ${JSON.stringify(error)}`,
        true,
      );
    }
    if (!response) {
      return this.createResponse(
        `No error recommendations payload returned for connector ${connectorName}.`,
        true,
      );
    }

    const recommendations = response.recommendations ?? [];
    const engineError = response.error;

    if (engineError) {
      return this.createResponse(
        `Recommendation engine error for connector ${connectorName}: ${JSON.stringify(
          { engineError, eventId: response.event_id },
        )}`,
        true,
      );
    }

    if (recommendations.length === 0) {
      return this.createResponse(
        `No error recommendations available for connector ${connectorName}.`,
      );
    }

    const projection: RecommendationsProjection = {
      connectorName,
      recommendations,
    };
    if (response.event_id) projection.eventId = response.event_id;

    return this.createResponse(
      `Error recommendations for ${connectorName}: ${JSON.stringify(projection)}`,
    );
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.GET_CONNECTOR_ERROR_RECOMMENDATIONS,
      description:
        "Get suggested remediation steps for a connector that has failed or is in an error state. Recommendations are generated server-side from the connector's recent failure traces and configuration. Returns a one-liner when no recommendations are available.",
      inputSchema: getConnectorErrorRecommendationsArguments.shape,
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
