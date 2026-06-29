import { CallToolResult } from "@src/confluent/schema.js";
import { READ_ONLY, ToolConfig } from "@src/confluent/tools/base-tools.js";
import { FlinkCatalogToolHandler } from "@src/confluent/tools/handlers/flink/catalog/flink-catalog-tool-handler.js";
import {
  executeFlinkSql,
  type FlinkStatementMeta,
} from "@src/confluent/tools/handlers/flink/flink-sql-helper.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { z } from "zod";

const listTablesArguments = z.object({
  catalogName: z
    .string()
    .trim()
    .optional()
    .describe(
      "The Flink catalog name (environment ID, e.g., env-xxxxx). Omit to use defaults.",
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

export class ListTablesHandler extends FlinkCatalogToolHandler {
  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const { organizationId, environmentId, computePoolId, catalogName } =
      listTablesArguments.parse(toolArguments);

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
    const catalog = this.resolveCatalogNameOrError(catalogName, environment_id);
    if (!catalog.ok) return catalog.error;
    const catalog_name = catalog.name;

    // Query INFORMATION_SCHEMA.TABLES for all tables
    // Must fully qualify with catalog and use backticks per Confluent Cloud requirements
    // Return all tables (excluding INFORMATION_SCHEMA) - client can filter by TABLE_SCHEMA as needed
    const sql = `SELECT \`TABLE_CATALOG\`, \`TABLE_SCHEMA\`, \`TABLE_NAME\`, \`TABLE_TYPE\` FROM \`${catalog_name}\`.\`INFORMATION_SCHEMA\`.\`TABLES\` WHERE \`TABLE_SCHEMA\` <> 'INFORMATION_SCHEMA'`;

    const result = await executeFlinkSql(clientManager, sql, {
      organizationId: organization_id,
      environmentId: environment_id,
      computePoolId: compute_pool_id,
    });
    const meta: FlinkStatementMeta = {
      flinkStatementsCreated: result.statementName
        ? [result.statementName]
        : [],
    };

    if (!result.success) {
      return this.createResponse(
        `Failed to list tables: ${result.error}`,
        true,
        meta,
      );
    }

    const tables = result.data ?? [];
    if (tables.length === 0) {
      return this.createResponse(
        `No tables found in catalog '${catalog_name}'.`,
        false,
        meta,
      );
    }

    return this.createResponse(
      `Tables in catalog '${catalog_name}':\n${JSON.stringify(tables, null, 2)}`,
      false,
      meta,
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
