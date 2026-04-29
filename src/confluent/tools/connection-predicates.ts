import type { ConnectionConfig } from "@src/config/models.js";

export type ConnectionPredicate = (conn: ConnectionConfig) => boolean;

export function hasKafka(conn: ConnectionConfig): boolean {
  return conn.kafka !== undefined;
}

export function hasKafkaBootstrap(conn: ConnectionConfig): boolean {
  return conn.kafka?.bootstrap_servers !== undefined;
}

export function hasKafkaAuth(conn: ConnectionConfig): boolean {
  return conn.kafka?.auth !== undefined;
}

export function hasKafkaRestWithAuth(conn: ConnectionConfig): boolean {
  return conn.kafka?.rest_endpoint !== undefined && hasKafkaAuth(conn);
}

export function hasSchemaRegistry(conn: ConnectionConfig): boolean {
  return conn.schema_registry !== undefined;
}

export function hasConfluentCloud(conn: ConnectionConfig): boolean {
  return conn.confluent_cloud !== undefined;
}

export function hasFlink(conn: ConnectionConfig): boolean {
  return conn.flink !== undefined;
}

export function hasTelemetry(conn: ConnectionConfig): boolean {
  return conn.telemetry !== undefined;
}

export function hasTableflow(conn: ConnectionConfig): boolean {
  return conn.tableflow !== undefined;
}

export function connectionIdsWhere(
  connections: Readonly<Record<string, ConnectionConfig>>,
  predicate: ConnectionPredicate,
): string[] {
  return Object.entries(connections)
    .filter(([, conn]) => predicate(conn))
    .map(([id]) => id);
}
