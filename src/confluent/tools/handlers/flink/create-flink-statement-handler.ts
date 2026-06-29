import { CallToolResult } from "@src/confluent/schema.js";
import { CREATE_UPDATE, ToolConfig } from "@src/confluent/tools/base-tools.js";
import { FlinkToolHandler } from "@src/confluent/tools/handlers/flink/flink-tool-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";

const createFlinkStatementArguments = z.object({
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
      "The catalog name to be used for the statement. Typically the environment's display name in Confluent Cloud.",
    ),
  databaseName: z
    .string()
    .trim()
    .optional()
    .describe(
      "The database name to be used for the statement. Typically the Kafka cluster name.",
    ),
  organizationId: z
    .string()
    .trim()
    .optional()
    .describe(
      "Confluent Cloud organization ID. Discover via list-organizations.",
    ),
  environmentId: z
    .string()
    .trim()
    .optional()
    .describe(
      "Confluent Cloud environment ID (env-...) that owns the Flink compute pool. Discover via list-environments.",
    ),
  computePoolId: z
    .string()
    .trim()
    .optional()
    .describe("Confluent Cloud Flink compute pool ID (lfcp-...)."),
});

export class CreateFlinkStatementHandler extends FlinkToolHandler {
  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const {
      catalogName,
      databaseName,
      statement,
      statementName,
      computePoolId,
      environmentId,
      organizationId,
    } = createFlinkStatementArguments.parse(toolArguments);
    const { conn, clientManager } = this.resolveConnection(
      runtime,
      toolArguments,
    );
    const { organization_id, environment_id, compute_pool_id } =
      this.resolveFlinkRouting(conn, {
        organizationId,
        environmentId,
        computePoolId,
      });
    const flink = conn.type === "direct" ? conn.flink : undefined;
    const resolvedCatalogName = this.resolveOptionalParam(
      catalogName,
      flink?.catalog_name,
    );
    const resolvedDatabaseName = this.resolveOptionalParam(
      databaseName,
      flink?.database_name,
    );

    const pathBasedClient = wrapAsPathBasedClient(
      await clientManager.getFlinkRestClient(compute_pool_id, environment_id),
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
