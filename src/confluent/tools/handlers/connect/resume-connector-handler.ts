import { CallToolResult } from "@src/confluent/schema.js";
import { CREATE_UPDATE, ToolConfig } from "@src/confluent/tools/base-tools.js";
import { ConnectToolHandler } from "@src/confluent/tools/handlers/connect/connect-tool-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";

const resumeConnectorArguments = z.object({
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
    .describe("The name of the connector to resume."),
});

export class ResumeConnectorHandler extends ConnectToolHandler {
  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const clientManager = runtime.clientManager;
    const { clusterId, environmentId, connectorName } =
      resumeConnectorArguments.parse(toolArguments);

    const conn = runtime.config.getSoleDirectConnection();
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
      inputSchema: resumeConnectorArguments.shape,
      annotations: CREATE_UPDATE,
    };
  }
}
