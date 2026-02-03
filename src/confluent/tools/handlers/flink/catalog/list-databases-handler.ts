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
import env from "@src/env.js";
import { z } from "zod";

const listDatabasesArguments = z.object({
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
});

export class ListDatabasesHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const {
      organizationId,
      environmentId,
      computePoolId,
      catalogName,
      baseUrl,
    } = listDatabasesArguments.parse(toolArguments);

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

    if (baseUrl !== undefined && baseUrl !== "") {
      clientManager.setConfluentCloudFlinkEndpoint(baseUrl);
    }

    // Build SQL query for INFORMATION_SCHEMA.SCHEMATA
    // Must fully qualify with catalog and use backticks per Confluent Cloud requirements
    const sql = `SELECT \`SCHEMA_ID\`, \`SCHEMA_NAME\` FROM \`${catalog_name}\`.\`INFORMATION_SCHEMA\`.\`SCHEMATA\` WHERE \`SCHEMA_NAME\` <> 'INFORMATION_SCHEMA'`;

    const result = await executeFlinkSql(clientManager, sql, {
      organizationId: organization_id,
      environmentId: environment_id,
      computePoolId: compute_pool_id,
    });

    if (!result.success) {
      return this.createResponse(
        `Failed to list databases: ${result.error}`,
        true,
      );
    }

    const databases = result.data ?? [];
    if (databases.length === 0) {
      return this.createResponse("No databases found.");
    }

    return this.createResponse(
      `Databases:\n${JSON.stringify(databases, null, 2)}`,
    );
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.LIST_FLINK_DATABASES,
      description:
        "List all databases (schemas) in a Flink catalog via INFORMATION_SCHEMA.SCHEMATA. Returns catalog and database names.",
      inputSchema: listDatabasesArguments.shape,
    };
  }

  getRequiredEnvVars(): EnvVar[] {
    return ["FLINK_API_KEY", "FLINK_API_SECRET"];
  }

  isConfluentCloudOnly(): boolean {
    return true;
  }
}
