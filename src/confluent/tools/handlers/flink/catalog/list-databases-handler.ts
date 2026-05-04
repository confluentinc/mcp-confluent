import { CallToolResult } from "@src/confluent/schema.js";
import { READ_ONLY, ToolConfig } from "@src/confluent/tools/base-tools.js";
import { resolveCatalogName } from "@src/confluent/tools/handlers/flink/catalog/catalog-resolver.js";
import { executeFlinkSql } from "@src/confluent/tools/handlers/flink/flink-sql-helper.js";
import { FlinkToolHandler } from "@src/confluent/tools/handlers/flink/flink-tool-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { z } from "zod";

const listDatabasesArguments = z.object({
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
  catalogName: z
    .string()
    .trim()
    .optional()
    .describe(
      "The Flink catalog name (environment ID, e.g., env-xxxxx). Omit to use defaults.",
    ),
});

export class ListDatabasesHandler extends FlinkToolHandler {
  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const clientManager = runtime.clientManager;
    const { organizationId, environmentId, computePoolId, catalogName } =
      listDatabasesArguments.parse(toolArguments);

    const conn = runtime.config.getSoleConnection();
    const { organization_id, environment_id } = this.resolveOrgAndEnvIds(
      conn,
      organizationId,
      environmentId,
    );
    const compute_pool_id = this.resolveComputePoolId(conn, computePoolId);
    // Smart resolution: only accept env-* format, otherwise fall back to flink.environment_id from connection config
    const catalog_name = resolveCatalogName(catalogName, environment_id);
    if (!catalog_name) {
      return this.createResponse(
        "Catalog name could not be resolved. Set flink.environment_id in config or provide a valid environment ID (env-xxxxx).",
        true,
      );
    }

    // Build SQL query for INFORMATION_SCHEMA.SCHEMATA
    // Must fully qualify with catalog and use backticks per Confluent Cloud requirements
    const sql = `SELECT \`SCHEMA_ID\`, \`SCHEMA_NAME\` FROM \`${catalog_name}\`.\`INFORMATION_SCHEMA\`.\`SCHEMATA\` WHERE \`SCHEMA_NAME\` <> 'INFORMATION_SCHEMA'`;

    const result = await executeFlinkSql(clientManager, sql, {
      organizationId: organization_id,
      environmentId: environment_id,
      computePoolId: compute_pool_id,
    });

    if (!result.success) {
      return this.createResponse(
        `Failed to list databases: ${result.error}`,
        true,
      );
    }

    const databases = result.data ?? [];
    if (databases.length === 0) {
      return this.createResponse("No databases found.");
    }

    return this.createResponse(
      `Databases:\n${JSON.stringify(databases, null, 2)}`,
    );
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.LIST_FLINK_DATABASES,
      description:
        "List all databases (schemas) in a Flink catalog via INFORMATION_SCHEMA.SCHEMATA. Returns catalog and database names.",
      inputSchema: listDatabasesArguments.shape,
      annotations: READ_ONLY,
    };
  }
}
