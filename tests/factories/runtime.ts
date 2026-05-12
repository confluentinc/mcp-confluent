import {
  loadConfigFromYaml,
  type DirectConnectionConfig,
} from "@src/config/index.js";
import { MCPServerConfiguration } from "@src/config/models.js";
import { DirectClientManager } from "@src/confluent/direct-client-manager.js";
import { OAuthClientManager } from "@src/confluent/oauth-client-manager.js";
import type { OAuthHolder } from "@src/confluent/oauth/oauth-holder.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { createMockInstance, type HandleCase } from "@tests/stubs/index.js";
import { fileURLToPath } from "node:url";
import type { Mocked } from "vitest";

/** Connection ID used by the named runtime factories and their default single-connection runtimes. */
export const DEFAULT_CONNECTION_ID = "default";

const CCLOUD_OAUTH_FIXTURE = fileURLToPath(
  new URL(
    "../../test-fixtures/yaml_configs/valid/ccloud-oauth.yaml",
    import.meta.url,
  ),
);

/**
 * Creates a ServerRuntime with a mocked ClientManager.
 *
 * Pass `connectionConfig` to populate the connection's service blocks (kafka,
 * flink, schema_registry, etc.).
 */
export function runtimeWith(
  connectionConfig: Omit<DirectConnectionConfig, "type"> = {},
  connectionId = DEFAULT_CONNECTION_ID,
  clientManager: Mocked<DirectClientManager> = createMockInstance(
    DirectClientManager,
  ),
): ServerRuntime {
  return new ServerRuntime(
    new MCPServerConfiguration({
      connections: { [connectionId]: { type: "direct", ...connectionConfig } },
    }),
    { [connectionId]: clientManager },
  );
}

/**
 * Multi-connection variant of {@linkcode runtimeWith}: builds a runtime whose
 * `config.connections` carries one `direct`-typed entry per record key, each
 * with a fresh stubbed `DirectClientManager`. Use when a test needs to
 * exercise cross-connection behaviour (partial-enable, (connectionId, reason)
 * grouping, lex-order pinning). Object-literal key order is preserved, so the
 * caller controls insertion order for tests that pin ordering invariants.
 */
export function runtimeWithConnections(
  connections: Record<string, Omit<DirectConnectionConfig, "type">>,
): ServerRuntime {
  const directConnections: Record<string, DirectConnectionConfig> = {};
  const clientManagers: Record<string, Mocked<DirectClientManager>> = {};
  for (const [id, conn] of Object.entries(connections)) {
    directConnections[id] = { type: "direct", ...conn };
    clientManagers[id] = createMockInstance(DirectClientManager);
  }
  return new ServerRuntime(
    new MCPServerConfiguration({ connections: directConnections }),
    clientManagers,
  );
}

/** Runtime with no service blocks — the disabled-baseline shape used by predicate-derivation tests in `base-tools.test.ts` and as a no-config runtime by handlers that don't read connection state. */
export function bareRuntime(): ServerRuntime {
  return runtimeWith();
}

/** Runtime with a kafka block. */
export function kafkaRuntime(): ServerRuntime {
  return runtimeWith({
    kafka: { bootstrap_servers: "broker:9092" },
  });
}

/** Shared Confluent Cloud control-plane connection config fixture for handle() tests. */
export const CCLOUD_CONN = {
  confluent_cloud: {
    endpoint: "https://api.confluent.cloud",
    auth: { type: "api_key" as const, key: "k", secret: "s" },
  },
};

/** Shared Flink connection config fixture for handle() tests. */
export const FLINK_CONN = {
  flink: {
    endpoint: "https://flink.example.com",
    auth: { type: "api_key" as const, key: "k", secret: "s" },
    environment_id: "env-from-config",
    organization_id: "org-from-config",
    compute_pool_id: "lfcp-from-config",
  },
};

/** Shared Kafka connection config fixture for handle() tests. */
export const KAFKA_CONN = {
  kafka: {
    bootstrap_servers: "broker:9092",
    rest_endpoint: "https://kafka-rest.example.com",
    auth: { type: "api_key" as const, key: "k", secret: "s" },
    cluster_id: "lkc-from-config",
  },
};

/** Shared Tableflow connection config fixture for handle() tests. */
export const TABLEFLOW_CONN = {
  tableflow: { auth: { type: "api_key" as const, key: "k", secret: "s" } },
  kafka: {
    env_id: "env-from-config",
    cluster_id: "lkc-from-config",
    rest_endpoint: "https://pkc-example.confluent.cloud:443",
  },
};

/**
 * Shared Connect handler fixture: CCloud control-plane + kafka block carrying
 * `env_id` and `cluster_id` for `resolveConnectEnvAndClusterId` fallback tests.
 */
export const CONNECT_CONN = {
  ...CCLOUD_CONN,
  kafka: {
    env_id: "env-from-config",
    cluster_id: "lkc-from-config",
    rest_endpoint: "https://pkc-example.confluent.cloud:443",
  },
};

/**
 * Like `CONNECT_CONN` but with `kafka.auth` — required by `CreateConnectorHandler`
 * which embeds Kafka API credentials in the connector body.
 */
export const CONNECT_CONN_WITH_AUTH = {
  ...CCLOUD_CONN,
  kafka: {
    env_id: "env-from-config",
    cluster_id: "lkc-from-config",
    rest_endpoint: "https://pkc-example.confluent.cloud:443",
    auth: {
      type: "api_key" as const,
      key: "kafka-key",
      secret: "kafka-secret",
    },
  },
};

/** Extends HandleCase with a per-case connection config for handle() tests
 *  that need to vary the runtime shape (e.g. empty config for throw cases). */
export type HandleCaseWithConn = HandleCase & {
  connectionConfig?: Parameters<typeof runtimeWith>[0];
};

/**
 * Shared per-case shape for Tableflow handle() tests. `mockResponse` is the
 * value the Tableflow REST client resolves with (omit for cases that throw
 * before reaching the client). `expectedEnvId` / `expectedClusterId` carry
 * the values the test asserts on the API call's env/cluster path — populated
 * for resolve-cases, omitted for throw-cases.
 */
export type TableflowHandleCase = HandleCaseWithConn & {
  mockResponse?: unknown;
  expectedEnvId?: string;
  expectedClusterId?: string;
};

/**
 * Shared per-case shape for Connect handle() tests. `mockResponse` is the value
 * the Confluent Cloud REST client resolves with — use `{ data }` for the
 * success path or `{ error }` for the API-error path; omit for cases that
 * throw before reaching the client. `expectedEnvId` / `expectedClusterId`
 * carry the values the test asserts on the API call's env/cluster path —
 * populated for resolve-cases, omitted for throw-cases.
 */
export type ConnectHandleCase = HandleCaseWithConn & {
  mockResponse?: { data?: unknown; error?: unknown };
  expectedEnvId?: string;
  expectedClusterId?: string;
};

/**
 * Shared per-case shape for Flink handle() tests whose handler reads a body
 * from a single Flink REST GET. `flinkGetData` is the value the Flink REST
 * client's GET resolves with — populated for resolve-cases, omitted for cases
 * that throw before reaching the client.
 */
export type FlinkGetCase = HandleCaseWithConn & {
  flinkGetData?: unknown;
};

/**
 * Runtime whose sole connection is an OAuth-typed `ConnectionConfig`, loaded
 * from the `ccloud-oauth.yaml` fixture. Used by the OAuth tool-surface
 * partition test in `src/index.test.ts` to confirm `getToolHandlersToRegister`
 * enables the expected set of tools against an OAuth runtime. A stub
 * `OAuthClientManager` is supplied solely to satisfy `ServerRuntime`'s
 * constructor — `enabledConnectionIds()` reads `runtime.config.connections`
 * and never touches the client manager. Pass `holder` to install a specific
 * {@link OAuthHolder} on the runtime (used by the gate-behavior tests).
 */
export function ccloudOAuthRuntime(holder?: OAuthHolder): ServerRuntime {
  const config = loadConfigFromYaml(CCLOUD_OAUTH_FIXTURE, {});
  return new ServerRuntime(
    config,
    { [DEFAULT_CONNECTION_ID]: createMockInstance(OAuthClientManager) },
    holder,
  );
}
