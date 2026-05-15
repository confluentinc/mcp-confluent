import type { DirectConnectionConfig } from "@src/config/index.js";
import { BaseClientManager } from "@src/confluent/base-client-manager.js";
import { executeFlinkSql } from "@src/confluent/tools/handlers/flink/flink-sql-helper.js";

/**
 * Resolves the Flink catalog name from various inputs.
 *
 * In Confluent Cloud Flink, the catalog name is always the environment ID (env-xxxxx).
 * Pass the already-resolved `environment_id` (from `resolveOrgAndEnvIds`) as
 * `fallbackEnvId` so that an explicit `environmentId` tool arg takes precedence
 * over the connection config value.
 *
 * Resolution order:
 * 1. If catalogName is provided and looks like an env ID (starts with "env-"), use it
 * 2. If fallbackEnvId looks like an env ID (starts with "env-"), use it
 * 3. Otherwise return undefined — callers should surface a configuration/argument error
 *
 * Both inputs are validated against the "env-" prefix so a non-env-* environmentId arg
 * (e.g. a friendly name) does not silently produce an invalid catalog name.
 *
 * @param catalogName - Optional catalog name from user/LLM input
 * @param fallbackEnvId - Already-resolved environment ID to use when catalogName is absent/invalid
 * @returns The resolved catalog name (environment ID), or undefined if not resolvable
 */
export function resolveCatalogName(
  catalogName?: string,
  fallbackEnvId?: string,
): string | undefined {
  if (catalogName && catalogName.startsWith("env-")) {
    return catalogName;
  }
  if (fallbackEnvId?.startsWith("env-")) {
    return fallbackEnvId;
  }
  return undefined;
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
 * 2. Otherwise, use kafka.cluster_id from connection config
 *
 * @param databaseName - Optional database name from user/LLM input
 * @returns The resolved database name, or undefined if not resolvable
 */
export function resolveDatabaseName(
  databaseName?: string,
  conn?: DirectConnectionConfig,
): string | undefined {
  // If any non-empty value is provided, use it (could be lkc-* or friendly name)
  if (databaseName && databaseName.trim()) {
    return databaseName.trim();
  }

  // Fall back to conn.kafka.cluster_id
  return conn?.kafka?.cluster_id?.trim() || undefined;
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
  clientManager: BaseClientManager,
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
  clientManager: BaseClientManager,
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
