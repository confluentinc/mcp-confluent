import { CallToolResult } from "@src/confluent/schema.js";
import { CREATE_UPDATE, ToolConfig } from "@src/confluent/tools/base-tools.js";
import { TableflowWithKafkaToolHandler } from "@src/confluent/tools/handlers/tableflow/tableflow-tool-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";

const createTableflowTopicArguments = z.object({
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
    .describe("The unique identifier for the Kafka Cluster."),
  tableflowTopicConfig: z.object({
    // Required fields
    display_name: z
      .string()
      .describe("The name of the Kafka topic for which Tableflow is enabled."),
    storage: z.object({
      kind: z
        .enum(["ByobAws", "Managed"])
        .default("ByobAws")
        .describe("The storage type either 'Managed' or 'ByobAws'."),
      bucket_name: z.string().describe("The bucket name."),
      provider_integration_id: z
        .string()
        .describe("The provider integration id."),
    }),
    // Optional fields
    suspended: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Indicates whether Tableflow should be suspended. The API allows setting it only to false i.e resume the Tableflow.",
      ),
    config: z.object({
      retention_ms: z
        .string()
        .default("6048000000") // equivalent to 7 days
        .describe(
          "The maximum age, in milliseconds, of snapshots (for Iceberg) or versions(for Delta) to retain in the table for the Tableflow-enabled topic.",
        ),
      record_failure_strategy: z
        .string()
        .default("SUSPEND")
        .describe(
          "The strategy to handle record failures in the Tableflow enabled topic during materialization.",
        ),
    }),
    table_formats: z
      .array(z.string())
      .default(["ICEBERG"])
      .describe(
        "The supported table formats for the Tableflow-enabled topic e.g ICEBERG, DELTA",
      ),
  }),
});

export class CreateTableFlowTopicHandler extends TableflowWithKafkaToolHandler {
  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const clientManager = runtime.clientManager;
    const { environmentId, clusterId, tableflowTopicConfig } =
      createTableflowTopicArguments.parse(toolArguments);

    const conn = runtime.config.getSoleDirectConnection();
    const { environment_id, kafka_cluster_id } =
      this.resolveTableflowEnvAndClusterId(conn, environmentId, clusterId);

    const pathBasedClient = wrapAsPathBasedClient(
      clientManager.getConfluentCloudTableflowRestClient(),
    );

    const { data: response, error } = await pathBasedClient[
      "/tableflow/v1/tableflow-topics"
    ].POST({
      body: {
        spec: {
          environment: {
            id: environment_id, // Only include id, as the general environment object also requires readonly and resource_name
          },
          kafka_cluster: {
            id: kafka_cluster_id,
            environment: environment_id,
          },
          ...tableflowTopicConfig,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any, // Due to how OpenAPI specification is structured and how generators interpret it, we have to treat it as any, as
        // The most likely culprit for mismatch is the reuse of a single base schema for both input (requestBody) and output (responses) evironment.
      },
    });
    if (error) {
      return this.createResponse(
        `Failed to create Tableflow topic for  ${tableflowTopicConfig.display_name}: ${JSON.stringify(error)}`,
        true,
      );
    }
    return this.createResponse(
      `Tableflow Topic ${tableflowTopicConfig.display_name} created: ${JSON.stringify(response)}`,
    );
  }
  getToolConfig(): ToolConfig {
    return {
      name: ToolName.CREATE_TABLEFLOW_TOPIC,
      description: `Make a request to create a tableflow topic.`,
      inputSchema: createTableflowTopicArguments.shape,
      annotations: CREATE_UPDATE,
    };
  }
}
