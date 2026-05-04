import { CallToolResult } from "@src/confluent/schema.js";
import { READ_ONLY, ToolConfig } from "@src/confluent/tools/base-tools.js";
import { resolveCatalogName } from "@src/confluent/tools/handlers/flink/catalog/catalog-resolver.js";
import { executeFlinkSql } from "@src/confluent/tools/handlers/flink/flink-sql-helper.js";
import { FlinkToolHandler } from "@src/confluent/tools/handlers/flink/flink-tool-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { z } from "zod";

const listTablesArguments = z.object({
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
  databaseName: z
    .string()
    .trim()
    .optional()
    .describe(
      "The database/schema name (Kafka cluster ID, e.g., lkc-xxxxx). Omit to list all tables across the catalog.",
    ),
});

export class ListTablesHandler extends FlinkToolHandler {
  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const clientManager = runtime.clientManager;
    const { organizationId, environmentId, computePoolId, catalogName } =
      listTablesArguments.parse(toolArguments);

    const flink = this.getFlinkDirectConfig(runtime.config);
    const { organization_id, environment_id } = this.resolveOrgAndEnvIds(
      flink,
      organizationId,
      environmentId,
    );
    const compute_pool_id = this.resolveComputePoolId(flink, computePoolId);
    // Smart resolution: only accept env-* format, otherwise fall back to flink.environment_id from connection config
    const catalog_name = resolveCatalogName(catalogName, environment_id);
    if (!catalog_name) {
      return this.createResponse(
        "Catalog name could not be resolved. Set flink.environment_id in config or provide a valid environment ID (env-xxxxx).",
        true,
      );
    }
    // databaseName is intentionally omitted — TABLE_SCHEMA contains friendly names, not cluster IDs,
    // so we fetch all tables and let the client filter by TABLE_SCHEMA as needed.

    // Query INFORMATION_SCHEMA.TABLES for all tables
    // Must fully qualify with catalog and use backticks per Confluent Cloud requirements
    // Return all tables (excluding INFORMATION_SCHEMA) - client can filter by TABLE_SCHEMA as needed
    const sql = `SELECT \`TABLE_CATALOG\`, \`TABLE_SCHEMA\`, \`TABLE_NAME\`, \`TABLE_TYPE\` FROM \`${catalog_name}\`.\`INFORMATION_SCHEMA\`.\`TABLES\` WHERE \`TABLE_SCHEMA\` <> 'INFORMATION_SCHEMA'`;

    const result = await executeFlinkSql(clientManager, sql, {
      organizationId: organization_id,
      environmentId: environment_id,
      computePoolId: compute_pool_id,
    });

    if (!result.success) {
      return this.createResponse(
        `Failed to list tables: ${result.error}`,
        true,
      );
    }

    const tables = result.data ?? [];
    if (tables.length === 0) {
      return this.createResponse(
        `No tables found in catalog '${catalog_name}'.`,
      );
    }

    return this.createResponse(
      `Tables in catalog '${catalog_name}':\n${JSON.stringify(tables, null, 2)}`,
    );
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.LIST_FLINK_TABLES,
      description:
        "List all tables in a Flink database via INFORMATION_SCHEMA.TABLES. Returns table names and types.",
      inputSchema: listTablesArguments.shape,
      annotations: READ_ONLY,
    };
  }
}
