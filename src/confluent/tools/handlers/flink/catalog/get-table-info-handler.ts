import { ClientManager } from "@src/confluent/client-manager.js";
import { getEnsuredParam } from "@src/confluent/helpers.js";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import {
  resolveCatalogName,
  resolveDatabaseName,
  getSchemaMapping,
  resolveToSchemaName,
} from "@src/confluent/tools/handlers/flink/catalog/catalog-resolver.js";
import { executeFlinkSql } from "@src/confluent/tools/handlers/flink/flink-sql-helper.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { EnvVar } from "@src/env-schema.js";
import env from "@src/env.js";
import { z } from "zod";

const getTableInfoArguments = z.object({
  baseUrl: z
    .string()
    .describe("The base URL of the Flink REST API.")
    .url()
    .default(() => env.FLINK_REST_ENDPOINT ?? "")
    .optional(),
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
    .describe("The name of the table to get info for."),
});

export class GetTableInfoHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const {
      organizationId,
      environmentId,
      computePoolId,
      catalogName,
      databaseName,
      tableName,
      baseUrl,
    } = getTableInfoArguments.parse(toolArguments);

    const organization_id = getEnsuredParam(
      "FLINK_ORG_ID",
      "Organization ID is required",
      organizationId,
    );
    const environment_id = getEnsuredParam(
      "FLINK_ENV_ID",
      "Environment ID is required",
      environmentId,
    );
    const compute_pool_id = getEnsuredParam(
      "FLINK_COMPUTE_POOL_ID",
      "Compute Pool ID is required",
      computePoolId,
    );
    // Smart resolution: only accept env-* format, otherwise fall back to FLINK_ENV_ID
    const catalog_name = resolveCatalogName(catalogName);
    if (!catalog_name) {
      return this.createResponse(
        "Catalog name could not be resolved. Set FLINK_ENV_ID or provide a valid environment ID (env-xxxxx).",
        true,
      );
    }
    // Database name is optional - if provided, resolve it to friendly SCHEMA_NAME
    const database_input = resolveDatabaseName(databaseName);

    if (baseUrl !== undefined && baseUrl !== "") {
      clientManager.setConfluentCloudFlinkEndpoint(baseUrl);
    }

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

    // Query INFORMATION_SCHEMA.TABLES for table metadata including watermarks
    // Must fully qualify with catalog and use backticks per Confluent Cloud requirements
    // If schema_name is provided, filter by it; otherwise search all databases for the table
    const schemaFilter = schema_name
      ? ` AND \`TABLE_SCHEMA\` = '${schema_name}'`
      : "";
    const sql = `SELECT \`TABLE_CATALOG\`, \`TABLE_SCHEMA\`, \`TABLE_NAME\`, \`TABLE_TYPE\`, \`IS_INSERTABLE_INTO\`, \`WATERMARK_COLUMN\`, \`WATERMARK_EXPRESSION\`, \`DISTRIBUTION_ALGORITHM\`, \`DISTRIBUTION_COLUMNS\`, \`DISTRIBUTION_BUCKET_COUNT\` FROM \`${catalog_name}\`.\`INFORMATION_SCHEMA\`.\`TABLES\` WHERE \`TABLE_NAME\` = '${tableName}'${schemaFilter}`;

    const result = await executeFlinkSql(clientManager, sql, {
      organizationId: organization_id,
      environmentId: environment_id,
      computePoolId: compute_pool_id,
    });

    if (!result.success) {
      return this.createResponse(
        `Failed to get table info: ${result.error}`,
        true,
      );
    }

    const tables = result.data ?? [];
    if (tables.length === 0) {
      const scope = schema_name
        ? `'${catalog_name}.${schema_name}.${tableName}'`
        : `'${tableName}' in catalog '${catalog_name}'`;
      return this.createResponse(`Table ${scope} not found.`, true);
    }

    return this.createResponse(
      `Table info for '${tableName}':\n${JSON.stringify(tables[0], null, 2)}`,
    );
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.GET_FLINK_TABLE_INFO,
      description:
        "Get table metadata via INFORMATION_SCHEMA.TABLES. Returns watermark configuration, distribution info, and table type.",
      inputSchema: getTableInfoArguments.shape,
    };
  }

  getRequiredEnvVars(): EnvVar[] {
    return ["FLINK_API_KEY", "FLINK_API_SECRET"];
  }

  isConfluentCloudOnly(): boolean {
    return true;
  }
}
