import { ClientManager } from "@src/confluent/client-manager.js";
import { executeFlinkSql } from "@src/confluent/tools/handlers/flink/flink-sql-helper.js";
import env from "@src/env.js";

/**
 * Resolves the Flink catalog name from various inputs.
 *
 * In Confluent Cloud Flink, the catalog name is always the environment ID (env-xxxxx).
 * This function handles cases where a friendly name or invalid value is provided,
 * falling back to the environment ID from config.
 *
 * Resolution order:
 * 1. If catalogName is provided and looks like an env ID (starts with "env-"), use it
 * 2. Otherwise, use FLINK_ENV_ID from environment
 *
 * @param catalogName - Optional catalog name from user/LLM input
 * @returns The resolved catalog name (environment ID), or undefined if not resolvable
 */
export function resolveCatalogName(catalogName?: string): string | undefined {
  // If provided value looks like an environment ID, use it
  if (catalogName && catalogName.startsWith("env-")) {
    return catalogName;
  }

  // Fall back to FLINK_ENV_ID (the actual environment ID)
  return env.FLINK_ENV_ID;
}

/**
 * Resolves the Flink database name from various inputs.
 *
 * In Confluent Cloud Flink, the database name can be either:
 * - A Kafka cluster ID (lkc-xxxxx)
 * - A friendly database name (e.g., "standard_cluster")
 *
 * INFORMATION_SCHEMA.TABLES uses friendly names in TABLE_SCHEMA, not cluster IDs.
 *
 * Resolution order:
 * 1. If databaseName is provided and non-empty, use it (could be cluster ID or friendly name)
 * 2. Otherwise, use KAFKA_CLUSTER_ID from environment
 *
 * @param databaseName - Optional database name from user/LLM input
 * @returns The resolved database name, or undefined if not resolvable
 */
export function resolveDatabaseName(databaseName?: string): string | undefined {
  // If any non-empty value is provided, use it (could be lkc-* or friendly name)
  if (databaseName && databaseName.trim()) {
    return databaseName.trim();
  }

  // Fall back to KAFKA_CLUSTER_ID
  return env.KAFKA_CLUSTER_ID;
}

export interface CatalogMapping {
  catalogId: string;
  catalogName: string;
}

export interface SchemaMapping {
  schemaId: string;
  schemaName: string;
}

/**
 * Looks up catalog mappings from INFORMATION_SCHEMA.CATALOGS.
 * Returns a 1:1 mapping between environment IDs (CATALOG_ID) and friendly names (CATALOG_NAME).
 */
export async function getCatalogMapping(
  clientManager: ClientManager,
  catalogName: string,
  options: {
    organizationId: string;
    environmentId: string;
    computePoolId: string;
  },
): Promise<CatalogMapping[]> {
  const sql = `SELECT \`CATALOG_ID\`, \`CATALOG_NAME\` FROM \`${catalogName}\`.\`INFORMATION_SCHEMA\`.\`CATALOGS\``;

  const result = await executeFlinkSql(clientManager, sql, {
    organizationId: options.organizationId,
    environmentId: options.environmentId,
    computePoolId: options.computePoolId,
  });

  if (!result.success || !result.data) {
    return [];
  }

  const mappings: CatalogMapping[] = [];
  for (const row of result.data) {
    const r = row as Record<string, unknown>;
    const catalogId = r?.CATALOG_ID;
    const catalogNameValue = r?.CATALOG_NAME;
    if (typeof catalogId === "string" && typeof catalogNameValue === "string") {
      mappings.push({ catalogId, catalogName: catalogNameValue });
    }
  }
  return mappings;
}

/**
 * Resolves a catalog identifier (could be env ID or friendly name) to the friendly CATALOG_NAME.
 *
 * @param catalogInput - The catalog identifier (env-xxxxx or friendly name)
 * @param mappings - The catalog mappings from getCatalogMapping()
 * @returns The friendly CATALOG_NAME to use in queries, or the original input if no mapping found
 */
export function resolveToCatalogName(
  catalogInput: string,
  mappings: CatalogMapping[],
): string {
  // If it looks like an environment ID, look up the friendly name
  if (catalogInput.startsWith("env-")) {
    const mapping = mappings.find((m) => m.catalogId === catalogInput);
    if (mapping) {
      return mapping.catalogName;
    }
  }

  // Otherwise, assume it's already a friendly name or return as-is
  return catalogInput;
}

/**
 * Looks up schema mappings from INFORMATION_SCHEMA.SCHEMATA.
 * Returns a 1:1 mapping between cluster IDs (SCHEMA_ID) and friendly names (SCHEMA_NAME).
 */
export async function getSchemaMapping(
  clientManager: ClientManager,
  catalogName: string,
  options: {
    organizationId: string;
    environmentId: string;
    computePoolId: string;
  },
): Promise<SchemaMapping[]> {
  const sql = `SELECT \`SCHEMA_ID\`, \`SCHEMA_NAME\` FROM \`${catalogName}\`.\`INFORMATION_SCHEMA\`.\`SCHEMATA\` WHERE \`SCHEMA_NAME\` <> 'INFORMATION_SCHEMA'`;

  const result = await executeFlinkSql(clientManager, sql, {
    organizationId: options.organizationId,
    environmentId: options.environmentId,
    computePoolId: options.computePoolId,
  });

  if (!result.success || !result.data) {
    return [];
  }

  const mappings: SchemaMapping[] = [];
  for (const row of result.data) {
    const r = row as Record<string, unknown>;
    const schemaId = r?.SCHEMA_ID;
    const schemaName = r?.SCHEMA_NAME;
    if (typeof schemaId === "string" && typeof schemaName === "string") {
      mappings.push({ schemaId, schemaName });
    }
  }
  return mappings;
}

/**
 * Resolves a database identifier (could be cluster ID or friendly name) to the friendly SCHEMA_NAME.
 * INFORMATION_SCHEMA queries use SCHEMA_NAME (friendly name) in TABLE_SCHEMA, not SCHEMA_ID.
 *
 * @param databaseInput - The database identifier (lkc-xxxxx or friendly name)
 * @param mappings - The schema mappings from getSchemaMapping()
 * @returns The friendly SCHEMA_NAME to use in queries, or the original input if no mapping found
 */
export function resolveToSchemaName(
  databaseInput: string,
  mappings: SchemaMapping[],
): string {
  // If it looks like a cluster ID, look up the friendly name
  if (databaseInput.startsWith("lkc-")) {
    const mapping = mappings.find((m) => m.schemaId === databaseInput);
    if (mapping) {
      return mapping.schemaName;
    }
  }

  // Otherwise, assume it's already a friendly name or return as-is
  return databaseInput;
}
