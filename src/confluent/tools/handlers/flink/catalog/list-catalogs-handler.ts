import { CallToolResult } from "@src/confluent/schema.js";
import { READ_ONLY, ToolConfig } from "@src/confluent/tools/base-tools.js";
import { resolveCatalogName } from "@src/confluent/tools/handlers/flink/catalog/catalog-resolver.js";
import { executeFlinkSql } from "@src/confluent/tools/handlers/flink/flink-sql-helper.js";
import { FlinkToolHandler } from "@src/confluent/tools/handlers/flink/flink-tool-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { z } from "zod";

const listCatalogsArguments = z.object({
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
});

export class ListCatalogsHandler extends FlinkToolHandler {
  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const clientManager = runtime.clientManager;
    const { organizationId, environmentId, computePoolId } =
      listCatalogsArguments.parse(toolArguments);

    const conn = runtime.config.getSoleConnection();
    const { organization_id, environment_id } = this.resolveOrgAndEnvIds(
      conn,
      organizationId,
      environmentId,
    );
    const compute_pool_id = this.resolveComputePoolId(conn, computePoolId);
    // Smart resolution: use flink.environment_id from connection config as the catalog name
    const catalog_name = resolveCatalogName(undefined, environment_id);
    if (!catalog_name) {
      return this.createResponse(
        "Catalog name could not be resolved. Set flink.environment_id in config.",
        true,
      );
    }

    // Query INFORMATION_SCHEMA.CATALOGS for all available catalogs
    // Must fully qualify with catalog and use backticks per Confluent Cloud requirements
    const sql = `SELECT \`CATALOG_NAME\` FROM \`${catalog_name}\`.\`INFORMATION_SCHEMA\`.\`CATALOGS\``;

    const result = await executeFlinkSql(clientManager, sql, {
      organizationId: organization_id,
      environmentId: environment_id,
      computePoolId: compute_pool_id,
    });

    if (!result.success) {
      return this.createResponse(
        `Failed to list catalogs: ${result.error}`,
        true,
      );
    }

    const catalogs = result.data ?? [];
    if (catalogs.length === 0) {
      return this.createResponse("No catalogs found.");
    }

    return this.createResponse(
      `Catalogs:\n${JSON.stringify(catalogs, null, 2)}`,
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
