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

const listDatabasesArguments = z.object({
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
    .describe(
      "Confluent Cloud Flink compute pool ID (lfcp-...). Discover via list-compute-pools.",
    ),
});

export class ListDatabasesHandler extends FlinkCatalogToolHandler {
  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const { organizationId, environmentId, computePoolId, catalogName } =
      listDatabasesArguments.parse(toolArguments);

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

    // Build SQL query for INFORMATION_SCHEMA.SCHEMATA
    // Must fully qualify with catalog and use backticks per Confluent Cloud requirements
    const sql = `SELECT \`SCHEMA_ID\`, \`SCHEMA_NAME\` FROM \`${catalog_name}\`.\`INFORMATION_SCHEMA\`.\`SCHEMATA\` WHERE \`SCHEMA_NAME\` <> 'INFORMATION_SCHEMA'`;

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
        `Failed to list databases: ${result.error}`,
        true,
        meta,
      );
    }

    const databases = result.data ?? [];
    if (databases.length === 0) {
      return this.createResponse("No databases found.", false, meta);
    }

    return this.createResponse(
      `Databases:\n${JSON.stringify(databases, null, 2)}`,
      false,
      meta,
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
