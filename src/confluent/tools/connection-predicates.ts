// Connection predicates: pure per-connection verdicts on whether a tool
// should be enabled for a given `ConnectionConfig`. Each predicate returns
// a `PredicateResult`; on failure the verdict carries a `ToolDisabledReason`
// so callers can explain why a tool is absent rather than silently dropping
// it from the catalogue.
//
// Tool handlers consume predicates indirectly: each handler declares a
// `predicate` property referencing one of this file's named exports, and
// `BaseToolHandler` derives both `enabledConnectionIds()` and
// `connectionVerdicts()` from it. Handlers must not call `allOf(...)` or
// `widenForOAuth(...)` at the use site — those combinators are construction
// tools used here to define new named exports. When adding a new named
// predicate here: also pin its consumer(s) in the `EXPECTED_PREDICATES`
// record inside `tool-registry.test.ts`'s `predicate property` block
// (typed `Readonly<Record<ToolName, ConnectionPredicate>>`, so missing
// rows fail `tsc` and combinators can't slip in as values) and add
// per-predicate coverage in `connection-predicates.test.ts`. The handler
// then sails through the per-tool identity assertion.
//
// OAuth note: most predicates short-circuit on `conn.type === "oauth"`
// and answer disabled — OAuth connections carry no service blocks for these
// predicates to inspect. Two mechanisms admit OAuth where it's supported:
// `hasConfluentCloud` answers enabled for OAuth directly (the CCloud REST URL
// is reachable via the Auth0 environment without a block), and the
// `widenForOAuth(predicate)` combinator wraps any block-checking predicate
// so OAuth connections bypass the block check and answer enabled. Use
// `widenForOAuth` here, when defining a new named composite export, for
// gates that should admit OAuth.

import type { ConnectionConfig } from "@src/config/models.js";

/**
 * A connection predicate's verdict on whether a tool should be enabled for a
 * given connection. Carries a {@linkcode ToolDisabledReason} when disabled so
 * that downstream consumers (startup logging, diagnostic tooling) can group
 * identical failures and render actionable messages to the user.
 */
export type PredicateResult =
  | { readonly enabled: true }
  | { readonly enabled: false; readonly reason: ToolDisabledReason };

export type ConnectionPredicate = (conn: ConnectionConfig) => PredicateResult;

export const ENABLED: PredicateResult = { enabled: true };

function disabled(reason: ToolDisabledReason): PredicateResult {
  return { enabled: false, reason };
}

/**
 * Block-level — required by any tool that needs Kafka access regardless of
 * transport (native client or REST proxy).
 */
export function hasKafka(conn: ConnectionConfig): PredicateResult {
  if (conn.type === "oauth")
    return disabled(ToolDisabledReason.OAuthNoServiceBlocks);
  if (conn.kafka === undefined)
    return disabled(ToolDisabledReason.MissingKafkaBlock);
  return ENABLED;
}

/**
 * Field-level — required by tools that drive the native Kafka
 * admin/producer/consumer client (the broker address lives on
 * `bootstrap_servers`).
 */
export function hasKafkaBootstrap(conn: ConnectionConfig): PredicateResult {
  if (conn.type === "oauth")
    return disabled(ToolDisabledReason.OAuthNoServiceBlocks);
  if (conn.kafka === undefined)
    return disabled(ToolDisabledReason.MissingKafkaBlock);
  if (conn.kafka.bootstrap_servers === undefined) {
    return disabled(ToolDisabledReason.MissingKafkaBootstrap);
  }
  return ENABLED;
}

/**
 * Field-level — required by tools that perform authenticated Kafka calls.
 */
export function hasKafkaAuth(conn: ConnectionConfig): PredicateResult {
  if (conn.type === "oauth")
    return disabled(ToolDisabledReason.OAuthNoServiceBlocks);
  if (conn.kafka === undefined)
    return disabled(ToolDisabledReason.MissingKafkaBlock);
  if (conn.kafka.auth === undefined)
    return disabled(ToolDisabledReason.MissingKafkaAuth);
  return ENABLED;
}

/**
 * Field-level — required by tools that talk to the Kafka REST proxy
 * (`/kafka/v3` endpoints); needs both `rest_endpoint` and `auth` on the
 * `kafka` block.
 */
export function hasKafkaRestWithAuth(conn: ConnectionConfig): PredicateResult {
  if (conn.type === "oauth")
    return disabled(ToolDisabledReason.OAuthNoServiceBlocks);
  if (conn.kafka === undefined)
    return disabled(ToolDisabledReason.MissingKafkaBlock);
  if (conn.kafka.rest_endpoint === undefined) {
    return disabled(ToolDisabledReason.MissingKafkaRestEndpoint);
  }
  if (conn.kafka.auth === undefined)
    return disabled(ToolDisabledReason.MissingKafkaAuth);
  return ENABLED;
}

/**
 * Block-level — required by tools that read or write through the Schema
 * Registry.
 */
export function hasSchemaRegistry(conn: ConnectionConfig): PredicateResult {
  if (conn.type === "oauth")
    return disabled(ToolDisabledReason.OAuthNoServiceBlocks);
  if (conn.schema_registry === undefined) {
    return disabled(ToolDisabledReason.MissingSchemaRegistryBlock);
  }
  return ENABLED;
}

/**
 * Block-level — verdict on whether the connection can reach the Confluent
 * Cloud control-plane REST surface. Direct connections satisfy this when
 * they carry a `confluent_cloud` block; OAuth connections satisfy it
 * unconditionally (the cloud REST URL is derived from the Auth0
 * environment).
 */
export function hasConfluentCloud(conn: ConnectionConfig): PredicateResult {
  if (conn.type === "oauth") return ENABLED;
  if (conn.confluent_cloud === undefined) {
    return disabled(ToolDisabledReason.MissingConfluentCloudBlock);
  }
  return ENABLED;
}

/**
 * Block-level — verdict that holds only for direct connections carrying a
 * `confluent_cloud` block. Use this instead of {@linkcode hasConfluentCloud}
 * for handlers that are not yet OAuth-capable and call
 * `getSoleDirectConnection()` inside `handle()`.
 */
export function hasDirectConfluentCloud(
  conn: ConnectionConfig,
): PredicateResult {
  if (conn.type === "oauth")
    return disabled(ToolDisabledReason.OAuthNotDirectCapable);
  if (conn.confluent_cloud === undefined) {
    return disabled(ToolDisabledReason.MissingConfluentCloudBlock);
  }
  return ENABLED;
}

/**
 * Block-level — required by tools that drive Flink SQL or its catalog.
 */
export function hasFlink(conn: ConnectionConfig): PredicateResult {
  if (conn.type === "oauth")
    return disabled(ToolDisabledReason.OAuthNoServiceBlocks);
  if (conn.flink === undefined)
    return disabled(ToolDisabledReason.MissingFlinkBlock);
  return ENABLED;
}

/**
 * Block-level — required by tools that read metrics from the Telemetry API.
 */
export function hasTelemetry(conn: ConnectionConfig): PredicateResult {
  if (conn.type === "oauth")
    return disabled(ToolDisabledReason.OAuthNoServiceBlocks);
  if (conn.telemetry === undefined)
    return disabled(ToolDisabledReason.MissingTelemetryBlock);
  return ENABLED;
}

/**
 * Block-level — required by tools that manage Tableflow topics or catalog
 * entries.
 */
export function hasTableflow(conn: ConnectionConfig): PredicateResult {
  if (conn.type === "oauth")
    return disabled(ToolDisabledReason.OAuthNoServiceBlocks);
  if (conn.tableflow === undefined)
    return disabled(ToolDisabledReason.MissingTableflowBlock);
  return ENABLED;
}

/**
 * Field-level — verdict that holds when the `schema_registry` block is
 * present and its `auth` field is `api_key`-typed. That combination is the
 * reliable signal that the SR is CCloud-hosted and therefore exposes the
 * `/catalog/v1/` endpoints. A vanilla CP SR has no auth, so it disables
 * even when the `schema_registry` block itself is present.
 */
export function hasCCloudCatalogSupport(
  conn: ConnectionConfig,
): PredicateResult {
  if (conn.type === "oauth")
    return disabled(ToolDisabledReason.OAuthNoServiceBlocks);
  if (conn.schema_registry === undefined) {
    return disabled(ToolDisabledReason.MissingSchemaRegistryBlock);
  }
  if (conn.schema_registry.auth?.type !== "api_key") {
    return disabled(ToolDisabledReason.MissingSchemaRegistryApiKeyAuth);
  }
  return ENABLED;
}

/**
 * Predicate that returns {@linkcode ENABLED} for every connection. Use as
 * the {@linkcode BaseToolHandler.predicate} for tools with no service-block
 * requirement (e.g., generic docs search).
 */
export const alwaysEnabled: ConnectionPredicate = () => ENABLED;

/**
 * Combine predicates with logical AND, short-circuiting on the first
 * failure. Returns {@linkcode ENABLED} only when every predicate passes for
 * the given connection; otherwise returns the first failing verdict so the
 * specific reason propagates downstream to startup logging and the
 * diagnostic-tool surface.
 *
 * Use this — never raw `predA(conn) && predB(conn)`. JavaScript boolean
 * composition silently drops the first operand because every
 * `PredicateResult` is a truthy object.
 */
export function allOf(
  ...predicates: ConnectionPredicate[]
): ConnectionPredicate {
  return (conn) => {
    for (const predicate of predicates) {
      const verdict = predicate(conn);
      if (!verdict.enabled) return verdict;
    }
    return ENABLED;
  };
}

/**
 * Wrap a predicate so OAuth connections always answer enabled. Use this on
 * tool handlers that have been adapted to operate against an OAuth-typed
 * connection at call time — the wrapped predicate's block-based verdict
 * still governs direct connections, while OAuth's "no service blocks"
 * early-exit is overridden.
 */
export function widenForOAuth(
  predicate: ConnectionPredicate,
): ConnectionPredicate {
  return (conn) => (conn.type === "oauth" ? ENABLED : predicate(conn));
}

/**
 * The native-Kafka client gate, widened to admit OAuth. Direct connections
 * still need `kafka.bootstrap_servers`; OAuth connections satisfy it
 * unconditionally (the broker URL is synthesized from the Auth0 environment).
 * Use on handlers that have been brought into the OAuth fold.
 */
export const kafkaBootstrapOrOAuth: ConnectionPredicate =
  widenForOAuth(hasKafkaBootstrap);

/**
 * The Kafka REST client gate, widened to admit OAuth. Direct connections still
 * need both `kafka.rest_endpoint` and `kafka.auth`; OAuth connections satisfy
 * it unconditionally (the per-cluster REST URL is resolved at call time via
 * the cmk REST API and the bearer middleware handles auth). Use on REST-tool
 * handlers (`get-topic-config`, `alter-topic-config`).
 */
export const kafkaRestWithAuthOrOAuth: ConnectionPredicate =
  widenForOAuth(hasKafkaRestWithAuth);

/**
 * Gate for tools that create connectors against the direct Confluent Cloud
 * REST surface: requires both a `confluent_cloud` block (the `/connect/v1`
 * endpoint) and `kafka.auth` (the connector spec carries kafka API
 * credentials). Strict-direct — OAuth connections answer `OAuthNotDirectCapable`
 * because the handler calls `getSoleDirectConnection()`.
 */
export const canCreateDirectConnector: ConnectionPredicate = allOf(
  hasDirectConfluentCloud,
  hasKafkaAuth,
);

/**
 * Gate for tools that read telemetry metrics about Flink statements:
 * requires both the `flink` block (to address a statement) and the
 * `telemetry` block (to query the metrics API).
 */
export const flinkWithTelemetry: ConnectionPredicate = allOf(
  hasFlink,
  hasTelemetry,
);

/**
 * Every reason a {@linkcode ConnectionPredicate} can return `enabled: false`.
 * The symbol is the wire-stable identifier (referenced from predicate bodies
 * and tests); the value is the human-readable phrasing surfaced to end users
 * through startup logs and diagnostic tooling.
 *
 * Adding a reason: name the symbol after what's missing from the connection
 * config (not which predicate emitted it — multiple predicates may share a
 * reason), and write the value as a declarative phrase a misconfigured user
 * could act on.
 */
export enum ToolDisabledReason {
  MissingKafkaBlock = "no 'kafka' block in connection config",
  MissingKafkaBootstrap = "'kafka' block does not have 'bootstrap_servers' field",
  MissingKafkaAuth = "'kafka' block does not have 'auth' field",
  MissingKafkaRestEndpoint = "'kafka' block does not have 'rest_endpoint' field",
  MissingSchemaRegistryBlock = "no 'schema_registry' block in connection config",
  MissingSchemaRegistryApiKeyAuth = "'schema_registry' block does not have 'auth' field of type 'api_key'",
  MissingConfluentCloudBlock = "no 'confluent_cloud' block in connection config",
  MissingFlinkBlock = "no 'flink' block in connection config",
  MissingTelemetryBlock = "no 'telemetry' block in connection config",
  MissingTableflowBlock = "no 'tableflow' block in connection config",
  OAuthNoServiceBlocks = "OAuth connections carry no service blocks",
  OAuthNotDirectCapable = "OAuth connection cannot satisfy a direct-only requirement",
}
