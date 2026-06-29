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

const listCatalogsArguments = z.object({
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

export class ListCatalogsHandler extends FlinkCatalogToolHandler {
  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const { organizationId, environmentId, computePoolId } =
      listCatalogsArguments.parse(toolArguments);

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
    const catalog = this.resolveCatalogNameOrError(undefined, environment_id);
    if (!catalog.ok) return catalog.error;
    const catalog_name = catalog.name;

    // Query INFORMATION_SCHEMA.CATALOGS for all available catalogs
    // Must fully qualify with catalog and use backticks per Confluent Cloud requirements
    const sql = `SELECT \`CATALOG_NAME\` FROM \`${catalog_name}\`.\`INFORMATION_SCHEMA\`.\`CATALOGS\``;

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
        `Failed to list catalogs: ${result.error}`,
        true,
        meta,
      );
    }

    const catalogs = result.data ?? [];
    if (catalogs.length === 0) {
      return this.createResponse("No catalogs found.", false, meta);
    }

    return this.createResponse(
      `Catalogs:\n${JSON.stringify(catalogs, null, 2)}`,
      false,
      meta,
    );
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.LIST_FLINK_CATALOGS,
      description:
        "List all catalogs available in the Flink environment via INFORMATION_SCHEMA.CATALOGS.",
      inputSchema: listCatalogsArguments.shape,
      annotations: READ_ONLY,
    };
  }
}
