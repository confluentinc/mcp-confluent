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
 * True when the connection points at a Confluent Cloud-hosted Schema Registry that
 * exposes the `/catalog/v1/` Stream Catalog endpoints.
 *
 * The reliable signal is the combination of:
 *   - a `schema_registry` block carrying api_key auth, AND
 *   - a `confluent_cloud` block (the Cloud control plane creds).
 *
 * Both signals together are required because the api_key auth shape alone is ambiguous:
 * a self-managed Confluent Platform deployment with HTTP Basic Auth in front of its SR
 * also models as `auth.type === "api_key"` in the YAML schema, even though that SR does
 * not serve `/catalog/v1/`. Without the `confluent_cloud` requirement, this predicate
 * would over-enable Stream Catalog tools on CP deployments and they would 404 at
 * runtime.
 */
export function hasCCloudCatalogSupport(conn: ConnectionConfig): boolean {
  return (
    conn.type === "direct" &&
    conn.schema_registry?.auth?.type === "api_key" &&
    conn.confluent_cloud !== undefined
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
