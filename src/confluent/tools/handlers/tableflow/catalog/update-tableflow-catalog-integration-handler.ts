import { ClientManager } from "@src/confluent/client-manager.js";
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

const updateTableflowCatalogIntegrationArguments = z.object({
  baseUrl: z
    .string()
    .trim()
    .describe("The base url of the Tableflow REST API.")
    .url()
    .default(() => env.CONFLUENT_CLOUD_REST_ENDPOINT ?? "")
    .optional(),
  tableflowCatalogIntegrationConfig: z.object({
    // Required fields
    display_name: z
      .string()
      .describe("The name of the Kafka topic for which Tableflow is enabled."),
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
    config: z.object({
      kind: z
        .string()
        .default("AwsGlue")
        .describe("The type of the catalog integration. AwsGlue, Snowflake"),
    }),
    // Optional fields
    suspended: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Indicates whether Tableflow Catalog Integration should be suspended. The API allows setting it only to false i.e resume the Catalog Integration.",
      ),
  }),
});

export class UpdateTableFlowCatalogIntegrationHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const { baseUrl, tableflowCatalogIntegrationConfig } =
      updateTableflowCatalogIntegrationArguments.parse(toolArguments);

    if (baseUrl !== undefined && baseUrl !== "") {
      clientManager.setConfluentCloudTableflowEndpoint(baseUrl);
    }

    const pathBasedClient = wrapAsPathBasedClient(
      clientManager.getConfluentCloudTableflowClient(),
    );

    const { environment, ...restOfTableflowCatalogIntegrationConfig } =
      tableflowCatalogIntegrationConfig;

    const { data: response, error } = await pathBasedClient[
      "/tableflow/v1/catalog-integrations"
    ].POST({
      body: {
        spec: {
          ...restOfTableflowCatalogIntegrationConfig,
          environment: { id: environment.id }, // Only include id, as the general environment as requires readonly and resource_name
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any, // Due to how OpenAPI specification is structured and how generators interpret it, we have to treat it as any, as
        // The most likely culprit for mismatch is the reuse of a single base schema for both input (requestBody) and output (responses) evironment.
      },
    });
    if (error) {
      return this.createResponse(
        `Failed to update Tableflow Catalog Integration for  ${tableflowCatalogIntegrationConfig.display_name}: ${JSON.stringify(error)}`,
        true,
      );
    }
    return this.createResponse(
      `Tableflow Catalog Integration ${tableflowCatalogIntegrationConfig.display_name} updated: ${JSON.stringify(response)}`,
    );
  }
  getToolConfig(): ToolConfig {
    return {
      name: ToolName.UPDATE_TABLEFLOW_CATALOG_INTEGRATION,
      description: `Make a request to update a catalog integration.`,
      inputSchema: updateTableflowCatalogIntegrationArguments.shape,
    };
  }

  getRequiredEnvVars(): EnvVar[] {
    return ["TABLEFLOW_API_KEY", "TABLEFLOW_API_SECRET"];
  }

  isConfluentCloudOnly(): boolean {
    return true;
  }
}
