import { CallToolResult } from "@src/confluent/schema.js";
import { READ_ONLY, ToolConfig } from "@src/confluent/tools/base-tools.js";
import {
  ConnectToolHandler,
  connectorByNameArguments,
} from "@src/confluent/tools/handlers/connect/connect-tool-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { wrapAsPathBasedClient } from "openapi-fetch";

interface RecommendationsProjection {
  connectorName: string;
  recommendations: string[];
  eventId?: string;
}

export class GetConnectorErrorRecommendationsHandler extends ConnectToolHandler {
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
    const { data: response, error } = await pathBasedClient[
      "/connect/v1/environments/{environment_id}/clusters/{kafka_cluster_id}/connectors/{connector_name}/error-recommendations"
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
      inputSchema: connectorByNameArguments.shape,
      annotations: READ_ONLY,
    };
  }
}
