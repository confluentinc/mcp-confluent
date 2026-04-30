import { getEnsuredParam } from "@src/confluent/helpers.js";
import { CallToolResult } from "@src/confluent/schema.js";
import { READ_ONLY, ToolConfig } from "@src/confluent/tools/base-tools.js";
import { TableflowToolHandler } from "@src/confluent/tools/handlers/tableflow/tableflow-tool-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";

const readTableflowTopicArguments = z.object({
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

export class ReadTableFlowTopicHandler extends TableflowToolHandler {
  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const clientManager = runtime.clientManager;
    const { display_name, environmentId, clusterId } =
      readTableflowTopicArguments.parse(toolArguments);

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
      clientManager.getConfluentCloudTableflowRestClient(),
    );

    const { data: response, error } = await pathBasedClient[
      `/tableflow/v1/tableflow-topics/${display_name}?environment=${environment_id}&spec.kafka_cluster=${kafka_cluster_id}`
    ].GET({
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
        `Failed to read Tableflow topic ${display_name}: ${JSON.stringify(error)}`,
        true,
      );
    }
    return this.createResponse(`Tableflow Topic: ${JSON.stringify(response)}`);
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.READ_TABLEFLOW_TOPIC,
      description: `Make a request to read a tableflow topic.`,
      inputSchema: readTableflowTopicArguments.shape,
      annotations: READ_ONLY,
    };
  }
}
