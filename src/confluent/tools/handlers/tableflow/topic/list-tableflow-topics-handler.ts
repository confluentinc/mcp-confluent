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

const listTableFlowTopicArguments = z.object({
  baseUrl: z
    .string()
    .trim()
    .describe("The base url of the Tableflow REST API.")
    .url()
    .default(() => env.CONFLUENT_CLOUD_REST_ENDPOINT ?? "")
    .optional(),
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

export class ListTableFlowTopicsHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const { clusterId, environmentId, baseUrl } =
      listTableFlowTopicArguments.parse(toolArguments);

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
      clientManager.setConfluentCloudRestEndpoint(baseUrl);
    }

    const pathBasedClient = wrapAsPathBasedClient(
      clientManager.getConfluentCloudRestClient(),
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
        `Failed to list Tableflow topics for  ${clusterId}: ${JSON.stringify(error)}`,
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
    };
  }

  getRequiredEnvVars(): EnvVar[] {
    return ["TABLEFLOW_API_KEY", "TABLEFLOW_API_SECRET"];
  }

  isConfluentCloudOnly(): boolean {
    return true;
  }
}
