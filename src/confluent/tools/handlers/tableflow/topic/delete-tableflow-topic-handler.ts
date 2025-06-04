import { ClientManager } from "@src/confluent/client-manager.js";
import { getEnsuredParam } from "@src/confluent/helpers.js";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { EnvVar } from "@src/env-schema.js";
import env from "@src/env.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";

const deleteTableflowTopicArguments = z.object({
  baseUrl: z
    .string()
    .trim()
    .describe("The base url of the Tableflow REST API.")
    .url()
    .default(() => env.CONFLUENT_CLOUD_REST_ENDPOINT ?? "")
    .optional(),
  display_name: z
    .string()
    .describe("The name of the Kafka topic for which Tableflow is enabled."),
  environmentId: z
    .string()
    .trim()
    .optional()
    .describe("Scope the operation to the given environment."),
  clusterId: z
    .string()
    .trim()
    .optional()
    .describe("Scope the operation to the give Kafka cluster."),
});

export class DeleteTableFlowTopicHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const { display_name, environmentId, clusterId, baseUrl } =
      deleteTableflowTopicArguments.parse(toolArguments);

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

    if (baseUrl !== undefined && baseUrl !== "") {
      clientManager.setConfluentCloudTableflowEndpoint(baseUrl);
    }

    const pathBasedClient = wrapAsPathBasedClient(
      clientManager.getConfluentCloudTableflowClient(),
    );

    const { data: response, error } = await pathBasedClient[
      `/tableflow/v1/tableflow-topics/${display_name}?environment=${environment_id}&spec.kafka_cluster=${kafka_cluster_id}`
    ].DELETE({
      params: {
        path: {
          display_name: display_name,
          environment_id: environment_id,
          kafka_cluster_id: kafka_cluster_id,
        },
      },
    });
    if (error) {
      return this.createResponse(
        `Failed to delete Tableflow topic ${display_name}: ${JSON.stringify(error)}`,
        true,
      );
    }
    return this.createResponse(
      `Tableflow Topic ${display_name} deleted: ${JSON.stringify(response)}`,
    );
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.DELETE_TABLEFLOW_TOPIC,
      description: `Make a request to delete a tableflow topic.`,
      inputSchema: deleteTableflowTopicArguments.shape,
    };
  }

  getRequiredEnvVars(): EnvVar[] {
    return ["TABLEFLOW_API_KEY", "TABLEFLOW_API_SECRET"];
  }

  isConfluentCloudOnly(): boolean {
    return true;
  }
}
