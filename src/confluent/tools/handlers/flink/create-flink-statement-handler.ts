import { CallToolResult } from "@src/confluent/schema.js";
import { CREATE_UPDATE, ToolConfig } from "@src/confluent/tools/base-tools.js";
import { FlinkToolHandler } from "@src/confluent/tools/handlers/flink/flink-tool-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";

const createFlinkStatementArguments = z.object({
  organizationId: z
    .string()
    .trim()
    .optional()
    .describe("The unique identifier for the organization."),
  environmentId: z
    .string()
    .trim()
    .optional()
    .describe("The unique identifier for the environment."),
  computePoolId: z
    .string()
    .trim()
    .optional()
    .describe("The id associated with the compute pool in context."),
  statement: z
    .string()
    .nonempty()
    .max(131072)
    .describe(
      "The raw Flink SQL text statement. Create table statements may not be necessary as topics in confluent cloud will be detected as created schemas. Make sure to show and describe tables before creating new ones.",
    ),
  statementName: z
    .string()
    .regex(
      new RegExp(
        "[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*",
      ),
    )
    .nonempty()
    .max(100)
    .describe(
      "The user provided name of the resource, unique within this environment.",
    ),
  catalogName: z
    .string()
    .trim()
    .optional()
    .describe(
      "The catalog name to be used for the statement. Typically the confluent environment name.",
    ),
  databaseName: z
    .string()
    .trim()
    .optional()
    .describe(
      "The database name to be used for the statement. Typically the Kafka cluster name.",
    ),
});

export class CreateFlinkStatementHandler extends FlinkToolHandler {
  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const clientManager = runtime.clientManager;
    const {
      catalogName,
      databaseName,
      statement,
      statementName,
      computePoolId,
      environmentId,
      organizationId,
    } = createFlinkStatementArguments.parse(toolArguments);
    const flink = this.getFlinkDirectConfig(runtime.config);
    const { organization_id, environment_id } = this.resolveOrgAndEnvIds(
      flink,
      organizationId,
      environmentId,
    );
    const compute_pool_id = this.resolveComputePoolId(flink, computePoolId);
    const resolvedCatalogName = this.resolveOptionalParam(
      catalogName,
      flink.environment_name,
    );
    const resolvedDatabaseName = this.resolveOptionalParam(
      databaseName,
      flink.database_name,
    );

    const pathBasedClient = wrapAsPathBasedClient(
      clientManager.getConfluentCloudFlinkRestClient(),
    );
    const { data: response, error } = await pathBasedClient[
      "/sql/v1/organizations/{organization_id}/environments/{environment_id}/statements"
    ].POST({
      params: {
        path: {
          environment_id: environment_id,
          organization_id: organization_id,
        },
      },
      body: {
        name: statementName,
        organization_id: organization_id,
        environment_id: environment_id,
        spec: {
          compute_pool_id: compute_pool_id,
          statement: statement,
          properties: {
            // only include the catalog and database properties if they are defined
            ...(resolvedCatalogName && {
              "sql.current-catalog": resolvedCatalogName,
            }),
            ...(resolvedDatabaseName && {
              "sql.current-database": resolvedDatabaseName,
            }),
          },
        },
      },
    });
    if (error) {
      return this.createResponse(
        `Failed to create Flink SQL statements: ${JSON.stringify(error)}`,
        true,
      );
    }
    return this.createResponse(`${JSON.stringify(response)}`);
  }
  getToolConfig(): ToolConfig {
    return {
      name: ToolName.CREATE_FLINK_STATEMENT,
      description: "Make a request to create a statement.",
      inputSchema: createFlinkStatementArguments.shape,
      annotations: CREATE_UPDATE,
    };
  }
}
