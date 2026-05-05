import { CallToolResult } from "@src/confluent/schema.js";
import { READ_ONLY, ToolConfig } from "@src/confluent/tools/base-tools.js";
import { TableflowWithKafkaToolHandler } from "@src/confluent/tools/handlers/tableflow/tableflow-tool-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";

const listTableFlowTopicArguments = z.object({
  environmentId: z
    .string()
    .trim()
    .optional()
    .describe(
      "The unique identifier for the enviornment this resource belongs to.",
    ),
  clusterId: z
    .string()
    .trim()
    .optional()
    .describe("The unique identifier for the Kafka Cluster."),
  pageSize: z
    .string()
    .trim()
    .optional()
    .default("10")
    .describe("The pagination size of collection requests."),
  pageToken: z
    .string()
    .trim()
    .optional()
    .default("0")
    .describe("An opaque pagination token for collection requests."),
});

export class ListTableFlowTopicsHandler extends TableflowWithKafkaToolHandler {
  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const clientManager = runtime.clientManager;
    const { clusterId, environmentId } =
      listTableFlowTopicArguments.parse(toolArguments);

    const conn = runtime.config.getSoleDirectConnection();
    const { environment_id, kafka_cluster_id } =
      this.resolveTableflowEnvAndClusterId(conn, environmentId, clusterId);

    const pathBasedClient = wrapAsPathBasedClient(
      clientManager.getConfluentCloudTableflowRestClient(),
    );

    const { data: response, error } = await pathBasedClient[
      `/tableflow/v1/tableflow-topics?environment=${environment_id}&spec.kafka_cluster=${kafka_cluster_id}`
    ].GET({
      params: {
        path: {
          environment_id: environment_id,
          kafka_cluster_id: kafka_cluster_id,
        },
      },
    });
    if (error) {
      return this.createResponse(
        `Failed to list Tableflow topics for  ${kafka_cluster_id}: ${JSON.stringify(error)}`,
        true,
      );
    }
    return this.createResponse(`Tableflow Topics: ${JSON.stringify(response)}`);
  }
  getToolConfig(): ToolConfig {
    return {
      name: ToolName.LIST_TABLEFLOW_TOPICS,
      description: `Retrieve a sorted, filtered, paginated list of all tableflow topics.`,
      inputSchema: listTableFlowTopicArguments.shape,
      annotations: READ_ONLY,
    };
  }
}
