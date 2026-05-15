import { CallToolResult } from "@src/confluent/schema.js";
import { READ_ONLY, ToolConfig } from "@src/confluent/tools/base-tools.js";
import {
  getSchemaMapping,
  resolveDatabaseName,
  resolveToSchemaName,
} from "@src/confluent/tools/handlers/flink/catalog/catalog-resolver.js";
import { FlinkCatalogToolHandler } from "@src/confluent/tools/handlers/flink/catalog/flink-catalog-tool-handler.js";
import { executeFlinkSql } from "@src/confluent/tools/handlers/flink/flink-sql-helper.js";
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
    const clientManager = runtime.clientManager;
    const {
      organizationId,
      environmentId,
      computePoolId,
      catalogName,
      databaseName,
      tableName,
    } = describeTableArguments.parse(toolArguments);

    const flink = this.getFlinkDirectConfig(runtime.config);
    const conn = runtime.config.getSoleDirectConnection(); // needed for kafka.cluster_id in resolveDatabaseName
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

    // If a database was specified, resolve cluster ID to friendly name
    let schema_name: string | undefined;
    if (database_input) {
      const mappings = await getSchemaMapping(clientManager, catalog_name, {
        organizationId: organization_id,
        environmentId: environment_id,
        computePoolId: compute_pool_id,
      });
      schema_name = resolveToSchemaName(database_input, mappings);
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

    if (!result.success) {
      return this.createResponse(
        `Failed to describe table: ${result.error}`,
        true,
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
      );
    }

    // Include TABLE_SCHEMA in response so user knows which database the table is in
    return this.createResponse(
      `Table '${tableName}' schema:\n${JSON.stringify(columns, null, 2)}`,
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
