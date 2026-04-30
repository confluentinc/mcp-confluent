import { ClientManager } from "@src/confluent/client-manager.js";
import { CallToolResult } from "@src/confluent/schema.js";
import { CREATE_UPDATE, ToolConfig } from "@src/confluent/tools/base-tools.js";
import { TableflowToolHandler } from "@src/confluent/tools/handlers/tableflow/tableflow-tool-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";

const updateTableflowTopicArguments = z.object({
  display_name: z
    .string()
    .describe("The name of the Kafka topic for which Tableflow is enabled."),
  tableflowTopicConfig: z.object({
    // Required fields
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
    environment: z.object({
      id: z
        .string()
        .describe(
          "The unique identifier for the environment this resource belongs to.",
        ),
    }),
    kafka_cluster: z.object({
      id: z.string().describe("ID of the referred resource"),
      environment: z
        .string()
        .describe("Environment of the referred resource, if env-scoped"),
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
        .default("SUSPENDED")
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

export class UpdateTableFlowTopicHandler extends TableflowToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const { display_name, tableflowTopicConfig } =
      updateTableflowTopicArguments.parse(toolArguments);

    const pathBasedClient = wrapAsPathBasedClient(
      clientManager.getConfluentCloudTableflowRestClient(),
    );

    const { environment, ...restOfTableflowConfig } = tableflowTopicConfig;

    const { data: response, error } = await pathBasedClient[
      `/tableflow/v1/tableflow-topics/${display_name}`
    ].PATCH({
      params: {
        path: {
          display_name: display_name,
        },
      },
      body: {
        spec: {
          ...restOfTableflowConfig,
          environment: { id: environment.id }, // Only include id, as the general environment as requires readonly and resource_name
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any, // Due to how OpenAPI specification is structured and how generators interpret it, we have to treat it as any, as
        // The most likely culprit for mismatch is the reuse of a single base schema for both input (requestBody) and output (responses) evironment.
      },
    });
    if (error) {
      return this.createResponse(
        `Failed to update Tableflow topic for  ${display_name}: ${JSON.stringify(error)}`,
        true,
      );
    }
    return this.createResponse(
      `Tableflow Topic ${display_name} updated: ${JSON.stringify(response)}`,
    );
  }
  getToolConfig(): ToolConfig {
    return {
      name: ToolName.UPDATE_TABLEFLOW_TOPIC,
      description: `Make a request to update a tableflow topic.`,
      inputSchema: updateTableflowTopicArguments.shape,
      annotations: CREATE_UPDATE,
    };
  }
}
