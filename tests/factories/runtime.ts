import {
  loadConfigFromYaml,
  type DirectConnectionConfig,
} from "@src/config/index.js";
import { MCPServerConfiguration } from "@src/config/models.js";
import { DirectClientManager } from "@src/confluent/direct-client-manager.js";
import { OAuthClientManager } from "@src/confluent/oauth-client-manager.js";
import type { OAuthHolder } from "@src/confluent/oauth/oauth-holder.js";
import type { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";
import {
  DECOY_CONNECTION_ID,
  createMockInstance,
  type HandleCase,
} from "@tests/stubs/index.js";
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
 * Multi-connection runtime factory — the primitive that owns the
 * `new ServerRuntime(new MCPServerConfiguration(...))` ceremony. Builds a
 * runtime whose `config.connections` carries one `direct`-typed entry per
 * record key. For each id, the caller may supply a specific
 * `Mocked<DirectClientManager>` via `clientManagers` (the pattern
 * multi-connection handler tests reach for when one connection's REST GET
 * resolves with data and another's errors); ids without an entry fall back
 * to a fresh `createMockInstance(DirectClientManager)`.
 */
export function runtimeWithConnections(
  connections: Record<string, Omit<DirectConnectionConfig, "type">>,
  clientManagers?: Partial<Record<string, Mocked<DirectClientManager>>>,
  allowedToolNames?: ReadonlySet<ToolName>,
): ServerRuntime {
  const directConnections: Record<string, DirectConnectionConfig> = {};
  const resolvedClientManagers: Record<
    string,
    Mocked<DirectClientManager>
  > = {};
  for (const [id, conn] of Object.entries(connections)) {
    directConnections[id] = { type: "direct", ...conn };
    resolvedClientManagers[id] =
      clientManagers?.[id] ?? createMockInstance(DirectClientManager);
  }
  return new ServerRuntime(
    new MCPServerConfiguration({ connections: directConnections }),
    resolvedClientManagers,
    undefined,
    allowedToolNames,
  );
}

/**
 * Single-connection sugar over {@linkcode runtimeWithConnections}. Pass
 * `connectionConfig` to populate the connection's service blocks (kafka,
 * flink, schema_registry, etc.).
 */
export function runtimeWith(
  connectionConfig: Omit<DirectConnectionConfig, "type"> = {},
  connectionId = DEFAULT_CONNECTION_ID,
  clientManager: Mocked<DirectClientManager> = createMockInstance(
    DirectClientManager,
  ),
  allowedToolNames?: ReadonlySet<ToolName>,
): ServerRuntime {
  return runtimeWithConnections(
    { [connectionId]: connectionConfig },
    { [connectionId]: clientManager },
    allowedToolNames,
  );
}

/**
 * Drop-in replacement for {@link runtimeWith} that additionally plants a
 * "decoy" connection carrying the same service blocks — enabled for the same
 * tools, with its own auto-minted client manager that correct routing must
 * never touch.
 *
 * The decoy is inserted FIRST, so a handler resolving via the legacy
 * sole-connection accessor (which grabs `enabledConnectionIds[0]`) routes to
 * the decoy and trips the test. {@link assertHandleCase} recognizes the decoy
 * (by {@link DECOY_CONNECTION_ID}) and, for any handle() test built on this
 * runtime, auto-routes to the real connection and asserts the decoy stayed
 * untouched — so swapping a suite's `runtimeWith` for this turns every existing
 * success case into a routing test with no other change.
 */
export function runtimeWithDecoy(
  connectionConfig: Omit<DirectConnectionConfig, "type"> = {},
  connectionId = DEFAULT_CONNECTION_ID,
  clientManager: Mocked<DirectClientManager> = createMockInstance(
    DirectClientManager,
  ),
  allowedToolNames?: ReadonlySet<ToolName>,
): ServerRuntime {
  if (connectionId === DECOY_CONNECTION_ID) {
    throw new Error(
      `Wacky -- runtimeWithDecoy's real connection id collides with the reserved decoy id "${DECOY_CONNECTION_ID}"`,
    );
  }
  return runtimeWithConnections(
    {
      [DECOY_CONNECTION_ID]: connectionConfig,
      [connectionId]: connectionConfig,
    },
    { [connectionId]: clientManager }, // decoy's manager is auto-minted by the factory
    allowedToolNames,
  );
}

/** Runtime with no service blocks — the disabled-baseline shape used by predicate-derivation tests in `base-tools.test.ts` and as a no-config runtime by handlers that don't read connection state. */
export function bareRuntime(): ServerRuntime {
  return runtimeWith();
}

/**
 * Runtime with a kafka block. When `clientManager` is supplied, threads it
 * through so that handler-call tests can configure mocked client behaviour
 * on the exact instance the handler will see; omit it (the
 * `enabledConnectionIds`-style predicate-only callsites) and a fresh
 * default-constructed mock is used.
 */
export function kafkaRuntime(
  clientManager?: Mocked<DirectClientManager>,
): ServerRuntime {
  return runtimeWith(
    { kafka: { bootstrap_servers: "broker:9092" } },
    DEFAULT_CONNECTION_ID,
    clientManager,
  );
}

/** Shared Confluent Cloud control-plane connection config fixture for handle() tests. */
export const CCLOUD_CONN = {
  confluent_cloud: {
    endpoint: "https://api.confluent.cloud",
    auth: { type: "api_key" as const, key: "k", secret: "s" },
  },
};

/**
 * Catalog/search connection fixture. `hasCCloudCatalogSupport` enables a
 * connection only when it carries a `confluent_cloud` block and a
 * `schema_registry` block with api_key auth — so a bare schema-registry
 * connection is not a valid route for these tools.
 */
export const CATALOG_CONN = {
  ...CCLOUD_CONN,
  schema_registry: {
    endpoint: "https://sr.example.com",
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
