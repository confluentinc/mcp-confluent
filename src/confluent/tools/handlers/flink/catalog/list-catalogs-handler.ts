import { ClientManager } from "@src/confluent/client-manager.js";
import { getEnsuredParam } from "@src/confluent/helpers.js";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { resolveCatalogName } from "@src/confluent/tools/handlers/flink/catalog/catalog-resolver.js";
import { executeFlinkSql } from "@src/confluent/tools/handlers/flink/flink-sql-helper.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { EnvVar } from "@src/env-schema.js";
import { z } from "zod";

const listCatalogsArguments = z.object({
  baseUrl: z
    .string()
    .describe("The base URL of the Flink REST API.")
    .url()
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
});

export class ListCatalogsHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const { organizationId, environmentId, computePoolId, baseUrl } =
      listCatalogsArguments.parse(toolArguments);

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
    // Smart resolution: use FLINK_ENV_ID as the catalog name
    const catalog_name = resolveCatalogName();
    if (!catalog_name) {
      return this.createResponse(
        "Catalog name could not be resolved. Set FLINK_ENV_ID.",
        true,
      );
    }

    if (baseUrl !== undefined && baseUrl !== "") {
      clientManager.setConfluentCloudFlinkEndpoint(baseUrl);
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
    };
  }

  getRequiredEnvVars(): EnvVar[] {
    return ["FLINK_API_KEY", "FLINK_API_SECRET"];
  }

  isConfluentCloudOnly(): boolean {
    return true;
  }
}
