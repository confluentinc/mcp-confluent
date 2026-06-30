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

const describeTableArguments = z.object({
  tableName: z
    .string()
    .trim()
    .nonempty()
    .describe("The name of the table to describe."),
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
    .describe(
      "Confluent Cloud Flink compute pool ID (lfcp-...). Discover via list-compute-pools.",
    ),
});

export class DescribeTableHandler extends FlinkCatalogToolHandler {
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
    } = describeTableArguments.parse(toolArguments);

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

    // Query INFORMATION_SCHEMA.COLUMNS for full schema details
    // Must fully qualify with catalog and use backticks per Confluent Cloud requirements
    // If schema_name is provided, filter by it; otherwise search all databases for the table
    const schemaFilter = schema_name
      ? ` AND \`TABLE_SCHEMA\` = '${schema_name}'`
      : "";
    const sql = `SELECT \`TABLE_SCHEMA\`, \`COLUMN_NAME\`, \`ORDINAL_POSITION\`, \`DATA_TYPE\`, \`FULL_DATA_TYPE\`, \`IS_NULLABLE\`, \`IS_HIDDEN\`, \`IS_GENERATED\`, \`GENERATION_EXPRESSION\`, \`IS_METADATA\`, \`METADATA_KEY\` FROM \`${catalog_name}\`.\`INFORMATION_SCHEMA\`.\`COLUMNS\` WHERE \`TABLE_NAME\` = '${tableName}' AND \`IS_HIDDEN\` = 'NO'${schemaFilter}`;

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
        `Failed to describe table: ${result.error}`,
        true,
        meta,
      );
    }

    const columns = result.data ?? [];
    if (columns.length === 0) {
      const scope = schema_name
        ? `'${catalog_name}.${schema_name}.${tableName}'`
        : `'${tableName}' in catalog '${catalog_name}'`;
      return this.createResponse(
        `Table ${scope} not found or has no columns.`,
        true,
        meta,
      );
    }

    // Include TABLE_SCHEMA in response so user knows which database the table is in
    return this.createResponse(
      `Table '${tableName}' schema:\n${JSON.stringify(columns, null, 2)}`,
      false,
      meta,
    );
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.DESCRIBE_FLINK_TABLE,
      description:
        "Get full schema details for a Flink table via INFORMATION_SCHEMA.COLUMNS. Returns column names, data types (including $rowtime), nullability, and metadata column info.",
      inputSchema: describeTableArguments.shape,
      annotations: READ_ONLY,
    };
  }
}
