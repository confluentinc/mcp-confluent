import type { ConnectionConfig } from "@src/config/models.js";

export type ConnectionPredicate = (conn: ConnectionConfig) => boolean;

// Block-presence predicates below check `conn.type === "direct"` first; OAuth
// connections carry no service blocks, so they answer false for every block.
// `hasConfluentCloud` is the single exception: it widens for OAuth because the
// CCloud REST URL is reachable via the Auth0 environment without a block.

export function hasKafka(conn: ConnectionConfig): boolean {
  return conn.type === "direct" && conn.kafka !== undefined;
}

export function hasKafkaBootstrap(conn: ConnectionConfig): boolean {
  return conn.type === "direct" && conn.kafka?.bootstrap_servers !== undefined;
}

export function hasKafkaAuth(conn: ConnectionConfig): boolean {
  return conn.type === "direct" && conn.kafka?.auth !== undefined;
}

export function hasKafkaRestWithAuth(conn: ConnectionConfig): boolean {
  return (
    conn.type === "direct" &&
    conn.kafka?.rest_endpoint !== undefined &&
    hasKafkaAuth(conn)
  );
}

export function hasSchemaRegistry(conn: ConnectionConfig): boolean {
  return conn.type === "direct" && conn.schema_registry !== undefined;
}

/**
 * True when the connection can reach the Confluent Cloud control-plane REST
 * surface. Direct connections satisfy this when they carry a `confluent_cloud`
 * block; OAuth connections satisfy it unconditionally (the cloud REST URL is
 * derived from the Auth0 environment).
 */
export function hasConfluentCloud(conn: ConnectionConfig): boolean {
  if (conn.type === "oauth") return true;
  return conn.confluent_cloud !== undefined;
}

/**
 * True only for direct connections that carry a `confluent_cloud` block.
 * Use this instead of `hasConfluentCloud` for handlers that are not yet
 * OAuth-capable and call `getSoleDirectConnection()` inside `handle()`.
 */
export function hasDirectConfluentCloud(conn: ConnectionConfig): boolean {
  return conn.type === "direct" && conn.confluent_cloud !== undefined;
}

export function hasFlink(conn: ConnectionConfig): boolean {
  return conn.type === "direct" && conn.flink !== undefined;
}

export function hasTelemetry(conn: ConnectionConfig): boolean {
  return conn.type === "direct" && conn.telemetry !== undefined;
}

export function hasTableflow(conn: ConnectionConfig): boolean {
  return conn.type === "direct" && conn.tableflow !== undefined;
}

/**
 * True when both a tableflow block and a kafka block are present on a direct connection.
 */
export function hasTableflowWithKafka(conn: ConnectionConfig): boolean {
  return (
    conn.type === "direct" &&
    conn.tableflow !== undefined &&
    conn.kafka !== undefined
  );
}

/**
 * True when a tableflow block is present and the kafka block carries both `env_id` and
 * `cluster_id`. Required by the eight Tableflow handlers that call
 * `resolveTableflowEnvAndClusterId()`: without both IDs available in config, those handlers
 * throw whenever the caller omits them as explicit arguments.
 */
export function hasTableflowWithKafkaEnvAndCluster(
  conn: ConnectionConfig,
): boolean {
  return (
    conn.type === "direct" &&
    conn.tableflow !== undefined &&
    conn.kafka?.env_id !== undefined &&
    conn.kafka?.cluster_id !== undefined
  );
}

/**
 * True when the schema_registry block is present and carries api_key auth.
 * That combination is the reliable signal that the SR is CCloud-hosted and therefore
 * exposes the /catalog/v1/ endpoints. A vanilla CP SR has no auth block, so it returns
 * false even when a schema_registry block is present.
 */
export function hasCCloudCatalogSupport(conn: ConnectionConfig): boolean {
  return (
    conn.type === "direct" && conn.schema_registry?.auth?.type === "api_key"
  );
}

export function connectionIdsWhere(
  connections: Readonly<Record<string, ConnectionConfig>>,
  predicate: ConnectionPredicate,
): string[] {
  return Object.entries(connections)
    .filter(([, conn]) => predicate(conn))
    .map(([id]) => id);
}
