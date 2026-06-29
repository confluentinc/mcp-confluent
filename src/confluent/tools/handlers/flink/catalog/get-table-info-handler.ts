import { CallToolResult } from "@src/confluent/schema.js";
import { READ_ONLY, ToolConfig } from "@src/confluent/tools/base-tools.js";
import {
  getSchemaMapping,
  resolveDatabaseName,
  resolveToSchemaName,
} from "@src/confluent/tools/handlers/flink/catalog/catalog-resolver.js";
import { FlinkCatalogToolHandler } from "@src/confluent/tools/handlers/flink/catalog/flink-catalog-tool-handler.js";
import {
  executeFlinkSql,
  type FlinkStatementMeta,
} from "@src/confluent/tools/handlers/flink/flink-sql-helper.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { z } from "zod";

const getTableInfoArguments = z.object({
  tableName: z
    .string()
    .trim()
    .nonempty()
    .describe("The name of the table to get info for."),
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
      "The database/schema name. Can be cluster ID (lkc-xxxxx) or friendly name. Optional.",
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

export class GetTableInfoHandler extends FlinkCatalogToolHandler {
  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const {
      organizationId,
      environmentId,
      computePoolId,
      catalogName,
      databaseName,
      tableName,
    } = getTableInfoArguments.parse(toolArguments);

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
    // Database name is optional - if provided, resolve it to friendly SCHEMA_NAME.
    // The config fallback (kafka.cluster_id) only exists on direct connections;
    // under OAuth callers supply databaseName explicitly.
    const database_input = resolveDatabaseName(
      databaseName,
      conn.type === "direct" ? conn : undefined,
    );

    const statementsCreated: string[] = [];

    // Only run getSchemaMapping for lkc-* inputs; resolveToSchemaName
    // passes friendly names through, so the roundtrip would just leak a
    // statement.
    let schema_name: string | undefined = database_input;
    if (database_input?.startsWith("lkc-")) {
      const lookup = await getSchemaMapping(clientManager, catalog_name, {
        organizationId: organization_id,
        environmentId: environment_id,
        computePoolId: compute_pool_id,
      });
      if (lookup.statementName) statementsCreated.push(lookup.statementName);
      schema_name = resolveToSchemaName(database_input, lookup.mappings);
    }

    // Query INFORMATION_SCHEMA.TABLES for table metadata including watermarks
    // Must fully qualify with catalog and use backticks per Confluent Cloud requirements
    // If schema_name is provided, filter by it; otherwise search all databases for the table
    const schemaFilter = schema_name
      ? ` AND \`TABLE_SCHEMA\` = '${schema_name}'`
      : "";
    const sql = `SELECT \`TABLE_CATALOG\`, \`TABLE_SCHEMA\`, \`TABLE_NAME\`, \`TABLE_TYPE\`, \`IS_DISTRIBUTED\`, \`DISTRIBUTION_ALGORITHM\`, \`DISTRIBUTION_BUCKETS\`, \`IS_WATERMARKED\`, \`WATERMARK_COLUMN\`, \`WATERMARK_EXPRESSION\`, \`WATERMARK_IS_HIDDEN\`, \`COMMENT\` FROM \`${catalog_name}\`.\`INFORMATION_SCHEMA\`.\`TABLES\` WHERE \`TABLE_NAME\` = '${tableName}'${schemaFilter}`;

    const result = await executeFlinkSql(clientManager, sql, {
      organizationId: organization_id,
      environmentId: environment_id,
      computePoolId: compute_pool_id,
    });
    if (result.statementName) statementsCreated.push(result.statementName);
    const meta: FlinkStatementMeta = {
      flinkStatementsCreated: statementsCreated,
    };

    if (!result.success) {
      return this.createResponse(
        `Failed to get table info: ${result.error}`,
        true,
        meta,
      );
    }

    const tables = result.data ?? [];
    if (tables.length === 0) {
      const scope = schema_name
        ? `'${catalog_name}.${schema_name}.${tableName}'`
        : `'${tableName}' in catalog '${catalog_name}'`;
      return this.createResponse(`Table ${scope} not found.`, true, meta);
    }

    return this.createResponse(
      `Table info for '${tableName}':\n${JSON.stringify(tables[0], null, 2)}`,
      false,
      meta,
    );
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.GET_FLINK_TABLE_INFO,
      description:
        "Get table metadata via INFORMATION_SCHEMA.TABLES. Returns watermark configuration, distribution info, and table type.",
      inputSchema: getTableInfoArguments.shape,
      annotations: READ_ONLY,
    };
  }
}
