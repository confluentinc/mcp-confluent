import type {
  ConfluentCloudDirectConfig,
  ConnectionConfig,
  DirectConnectionConfig,
  FlinkDirectConfig,
  KafkaDirectConfig,
  OAuthConnectionConfig,
  SchemaRegistryDirectConfig,
  TableflowDirectConfig,
  TelemetryDirectConfig,
} from "@src/config/models.js";

/**
 * How the `describe-configured-connection` card treats one connection-config
 * field. The visibility maps below are keyed `Record<keyof T, FieldVisibility>`
 * over each connection arm and service block, so adding a config field fails
 * `tsc --noEmit` (which runs in the pre-push hook and CI) until it is
 * classified here — a new knob can never ship without a deliberate
 * surface/withhold decision, and a secret-leak audit stays a single-file review.
 *
 * - `public` — non-secret scalar; surfaced in the card.
 * - `secret` — credential material (`auth` blocks); never surfaced. Audit these.
 * - `withheld` — non-secret but deliberately not surfaced: either a structured /
 *   opaque value (`extra_properties`) or one the card surfaces by other means
 *   (`read_only`, echoed as the coerced top-level `readOnly` boolean instead).
 * - `block` — a nested service block; surfaced via its own map in
 *   {@link SERVICE_BLOCK_VISIBILITY}. Only appears at the connection level.
 */
export type FieldVisibility = "public" | "secret" | "withheld" | "block";

export const KAFKA_FIELD_VISIBILITY: Readonly<
  Record<keyof KafkaDirectConfig, FieldVisibility>
> = {
  bootstrap_servers: "public",
  rest_endpoint: "public",
  cluster_id: "public",
  env_id: "public",
  auth: "secret",
  // Free-form librdkafka property bag; can carry credential-ish values, so it
  // stays unsurfaced even though it is not inherently a secret.
  extra_properties: "withheld",
};

export const SCHEMA_REGISTRY_FIELD_VISIBILITY: Readonly<
  Record<keyof SchemaRegistryDirectConfig, FieldVisibility>
> = {
  endpoint: "public",
  auth: "secret",
};

export const CONFLUENT_CLOUD_FIELD_VISIBILITY: Readonly<
  Record<keyof ConfluentCloudDirectConfig, FieldVisibility>
> = {
  endpoint: "public",
  organization_id: "public",
  auth: "secret",
};

export const TABLEFLOW_FIELD_VISIBILITY: Readonly<
  Record<keyof TableflowDirectConfig, FieldVisibility>
> = {
  auth: "secret",
};

export const TELEMETRY_FIELD_VISIBILITY: Readonly<
  Record<keyof TelemetryDirectConfig, FieldVisibility>
> = {
  endpoint: "public",
  auth: "secret",
};

export const FLINK_FIELD_VISIBILITY: Readonly<
  Record<keyof FlinkDirectConfig, FieldVisibility>
> = {
  endpoint: "public",
  environment_id: "public",
  organization_id: "public",
  compute_pool_id: "public",
  catalog_name: "public",
  database_name: "public",
  auth: "secret",
};

export const DIRECT_CONNECTION_FIELD_VISIBILITY: Readonly<
  Record<keyof DirectConnectionConfig, FieldVisibility>
> = {
  type: "public",
  description: "public",
  // Echoed as the coerced top-level `readOnly` boolean by the handler, so the
  // raw snake_case field is withheld from the generic scalar pass.
  read_only: "withheld",
  kafka: "block",
  schema_registry: "block",
  confluent_cloud: "block",
  tableflow: "block",
  telemetry: "block",
  flink: "block",
};

export const OAUTH_CONNECTION_FIELD_VISIBILITY: Readonly<
  Record<keyof OAuthConnectionConfig, FieldVisibility>
> = {
  type: "public",
  description: "public",
  read_only: "withheld",
  ccloud_env: "public",
  kafka_debug: "public",
};

/**
 * Field-visibility map for each direct-connection service block, keyed by the
 * block's connection-field name. The keys are exactly the
 * {@link DIRECT_CONNECTION_FIELD_VISIBILITY} entries classified `"block"`
 * (pinned by the drift-catch test in `describe-fields.test.ts`).
 */
export const SERVICE_BLOCK_VISIBILITY: Readonly<
  Record<string, Readonly<Record<string, FieldVisibility>>>
> = {
  kafka: KAFKA_FIELD_VISIBILITY,
  schema_registry: SCHEMA_REGISTRY_FIELD_VISIBILITY,
  confluent_cloud: CONFLUENT_CLOUD_FIELD_VISIBILITY,
  tableflow: TABLEFLOW_FIELD_VISIBILITY,
  telemetry: TELEMETRY_FIELD_VISIBILITY,
  flink: FLINK_FIELD_VISIBILITY,
};

/**
 * The config-derived portion of a `describe-configured-connection` card:
 * `scalars` holds the connection's `public` connection-level fields (e.g.
 * `type`, `description`, and OAuth's `ccloud_env` / `kafka_debug`); `blocks`
 * maps each present service block to its `public` fields. Secrets and
 * `withheld` fields never appear in either.
 */
export interface ConnectionCard {
  readonly scalars: Record<string, unknown>;
  readonly blocks: Record<string, Record<string, unknown>>;
}

/**
 * Project a connection into its non-secret card, driven entirely by the
 * visibility maps. OAuth connections carry no service blocks, so `blocks` is
 * empty for them; the `public`/`secret`/`withheld`/`block` switch is the single
 * place the surface/withhold decision is enforced at runtime.
 */
export function buildConnectionCard(conn: ConnectionConfig): ConnectionCard {
  const connectionMap =
    conn.type === "oauth"
      ? OAUTH_CONNECTION_FIELD_VISIBILITY
      : DIRECT_CONNECTION_FIELD_VISIBILITY;
  const fields = conn as unknown as Record<string, unknown>;

  const scalars: Record<string, unknown> = {};
  const blocks: Record<string, Record<string, unknown>> = {};

  for (const [key, visibility] of Object.entries(connectionMap)) {
    const value = fields[key];
    switch (visibility) {
      case "public":
        if (value !== undefined) scalars[key] = value;
        break;
      case "block":
        if (value !== undefined) {
          blocks[key] = projectBlock(
            SERVICE_BLOCK_VISIBILITY[key]!,
            value as Record<string, unknown>,
          );
        }
        break;
      case "secret":
      case "withheld":
        break;
      default:
        throw new Error(
          `Wacky -- unhandled field visibility "${visibility as string}" for connection field "${key}"`,
        );
    }
  }

  return { scalars, blocks };
}

/** Project one service block to the `public` fields it actually carries. */
function projectBlock(
  blockMap: Readonly<Record<string, FieldVisibility>>,
  blockValue: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, visibility] of Object.entries(blockMap)) {
    if (visibility === "public" && blockValue[field] !== undefined) {
      out[field] = blockValue[field];
    }
  }
  return out;
}
