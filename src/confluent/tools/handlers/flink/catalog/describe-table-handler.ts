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
      "The database/schema name. Can be cluster ID (lkc-xxxxx) or friendly name. Optional.",
    ),
  tableName: z
    .string()
    .trim()
    .nonempty()
    .describe("The name of the table to describe."),
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

    const { conn, clientManager } = this.resolveDirectConnection(
      runtime,
      toolArguments,
    );
    const flink = this.getFlinkDirectConfig(conn);
    const { organization_id, environment_id } = this.resolveOrgAndEnvIds(
      flink,
      organizationId,
      environmentId,
    );
    const compute_pool_id = this.resolveComputePoolId(flink, computePoolId);
    const catalog = this.resolveCatalogNameOrError(catalogName, environment_id);
    if (!catalog.ok) return catalog.error;
    const catalog_name = catalog.name;
    // Database name is optional - if provided, resolve it to friendly SCHEMA_NAME
    const database_input = resolveDatabaseName(databaseName, conn);

    const statementsCreated: string[] = [];
    const flinkScope = {
      organizationId: organization_id,
      environmentId: environment_id,
      computePoolId: compute_pool_id,
    };

    // Only run getSchemaMapping for lkc-* inputs; resolveToSchemaName
    // passes friendly names through, so the roundtrip would just leak a
    // statement. Done once here and shared by both INFORMATION_SCHEMA queries
    // below — the whole reason this tool absorbed get-flink-table-info rather
    // than living alongside it.
    let schema_name: string | undefined = database_input;
    if (database_input?.startsWith("lkc-")) {
      const lookup = await getSchemaMapping(
        clientManager,
        catalog_name,
        flinkScope,
      );
      if (lookup.statementName) statementsCreated.push(lookup.statementName);
      schema_name = resolveToSchemaName(database_input, lookup.mappings);
    }

    // Both queries fully qualify with catalog and backtick-quote per Confluent
    // Cloud requirements. If schema_name is provided, filter by it; otherwise
    // search all databases for the table.
    const schemaFilter = schema_name
      ? ` AND \`TABLE_SCHEMA\` = '${schema_name}'`
      : "";

    // Column-level schema (the primary "describe" payload).
    const columnsSql = `SELECT \`TABLE_SCHEMA\`, \`COLUMN_NAME\`, \`ORDINAL_POSITION\`, \`DATA_TYPE\`, \`FULL_DATA_TYPE\`, \`IS_NULLABLE\`, \`IS_HIDDEN\`, \`IS_GENERATED\`, \`GENERATION_EXPRESSION\`, \`IS_METADATA\`, \`METADATA_KEY\` FROM \`${catalog_name}\`.\`INFORMATION_SCHEMA\`.\`COLUMNS\` WHERE \`TABLE_NAME\` = '${tableName}' AND \`IS_HIDDEN\` = 'NO'${schemaFilter}`;
    // Table-level metadata: watermarks, distribution, table type.
    const tableInfoSql = `SELECT \`TABLE_CATALOG\`, \`TABLE_SCHEMA\`, \`TABLE_NAME\`, \`TABLE_TYPE\`, \`IS_DISTRIBUTED\`, \`DISTRIBUTION_ALGORITHM\`, \`DISTRIBUTION_BUCKETS\`, \`IS_WATERMARKED\`, \`WATERMARK_COLUMN\`, \`WATERMARK_EXPRESSION\`, \`WATERMARK_IS_HIDDEN\`, \`COMMENT\` FROM \`${catalog_name}\`.\`INFORMATION_SCHEMA\`.\`TABLES\` WHERE \`TABLE_NAME\` = '${tableName}'${schemaFilter}`;

    const columnsResult = await executeFlinkSql(
      clientManager,
      columnsSql,
      flinkScope,
    );
    if (columnsResult.statementName)
      statementsCreated.push(columnsResult.statementName);

    // Columns are the essential payload — if that query fails, the whole call
    // fails (matches the pre-merge describe-flink-table behavior).
    if (!columnsResult.success) {
      return this.createResponse(
        `Failed to describe table: ${columnsResult.error}`,
        true,
        {
          flinkStatementsCreated: statementsCreated,
        } satisfies FlinkStatementMeta,
      );
    }

    const infoResult = await executeFlinkSql(
      clientManager,
      tableInfoSql,
      flinkScope,
    );
    if (infoResult.statementName)
      statementsCreated.push(infoResult.statementName);

    const meta: FlinkStatementMeta = {
      flinkStatementsCreated: statementsCreated,
    };

    const columns = columnsResult.data ?? [];
    // Table metadata is supplementary: a failed/empty TABLES query must not sink
    // a successful columns describe, so degrade to null rather than erroring.
    const metadata = infoResult.success ? (infoResult.data?.[0] ?? null) : null;

    if (columns.length === 0 && metadata === null) {
      const scope = schema_name
        ? `'${catalog_name}.${schema_name}.${tableName}'`
        : `'${tableName}' in catalog '${catalog_name}'`;
      return this.createResponse(`Table ${scope} not found.`, true, meta);
    }

    return this.createResponse(
      `Table '${tableName}':\n${JSON.stringify({ metadata, columns }, null, 2)}`,
      false,
      meta,
    );
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.DESCRIBE_FLINK_TABLE,
      description:
        "Describe a Flink table: returns its full column schema (names, data types including $rowtime, nullability, and metadata columns) together with table-level metadata (watermark configuration, distribution, and table type). Use this whenever you need to understand a table's shape before querying it — it answers in one call what previously required both a column lookup and a separate table-info lookup.",
      inputSchema: describeTableArguments.shape,
      annotations: READ_ONLY,
    };
  }
}
