import {
  loadConfigFromYaml,
  type DirectConnectionConfig,
} from "@src/config/index.js";
import { MCPServerConfiguration } from "@src/config/models.js";
import { DirectClientManager } from "@src/confluent/direct-client-manager.js";
import { OAuthClientManager } from "@src/confluent/oauth-client-manager.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { createMockInstance, type HandleCase } from "@tests/stubs/index.js";
import { fileURLToPath } from "node:url";
import type { Mocked } from "vitest";

/** Connection ID used by the named runtime factories and their default single-connection runtimes. */
export const DEFAULT_CONNECTION_ID = "default";

/**
 * Connection ID used by {@link ccloudOAuthRuntime}, matching the connection
 * name in `test-fixtures/yaml_configs/valid/ccloud-oauth.yaml`. Distinct from
 * {@link DEFAULT_CONNECTION_ID} because the OAuth runtime is anchored to a
 * real YAML fixture rather than constructed inline.
 */
export const CCLOUD_OAUTH_CONNECTION_ID = "ccloud";

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

/** Runtime with no service blocks — the disabled case in enabledConnectionIds() tests. */
export function bareRuntime(): ServerRuntime {
  return runtimeWith();
}

/** Runtime with a schema_registry block. */
export function schemaRegistryRuntime(): ServerRuntime {
  return runtimeWith({
    schema_registry: { endpoint: "https://schema-registry.example.com" },
  });
}

/** Runtime with a confluent_cloud block. */
export function confluentCloudRuntime(): ServerRuntime {
  return runtimeWith({
    confluent_cloud: {
      endpoint: "https://api.confluent.cloud",
      auth: { type: "api_key", key: "k", secret: "s" },
    },
  });
}

/** Runtime with a CCloud-hosted schema_registry (api_key auth) — the minimal enabled case for catalog-API tools. */
export function ccloudSchemaRegistryRuntime(): ServerRuntime {
  return runtimeWith({
    schema_registry: {
      endpoint: "https://psrc-abc.us-east-1.aws.confluent.cloud",
      auth: { type: "api_key", key: "k", secret: "s" },
    },
  });
}

/** Runtime with a kafka block. */
export function kafkaRuntime(): ServerRuntime {
  return runtimeWith({
    kafka: { bootstrap_servers: "broker:9092" },
  });
}

/** Runtime with a kafka block containing only a rest_endpoint (no bootstrap_servers) — the disabled case for admin-client handlers. */
export function kafkaRestOnlyRuntime(): ServerRuntime {
  return runtimeWith({
    kafka: { rest_endpoint: "https://kafka-rest.example.com" },
  });
}

/** Runtime with a kafka block including a rest_endpoint and auth. */
export function kafkaRestRuntime(): ServerRuntime {
  return runtimeWith({
    kafka: {
      bootstrap_servers: "broker:9092",
      rest_endpoint: "https://kafka-rest.example.com",
      auth: { type: "api_key", key: "k", secret: "s" },
    },
  });
}

/** Runtime with a tableflow block. */
export function tableflowRuntime(): ServerRuntime {
  return runtimeWith({
    tableflow: { auth: { type: "api_key", key: "k", secret: "s" } },
  });
}

/** Runtime with a flink block. */
export function flinkRuntime(): ServerRuntime {
  return runtimeWith({
    flink: {
      endpoint: "https://flink.us-east-1.aws.confluent.cloud",
      auth: { type: "api_key", key: "k", secret: "s" },
      environment_id: "env-abc123",
      organization_id: "org-xyz789",
      compute_pool_id: "lfcp-pool01",
    },
  });
}

/** Runtime with a telemetry block. */
export function telemetryRuntime(): ServerRuntime {
  return runtimeWith({
    telemetry: {
      endpoint: "https://api.telemetry.confluent.cloud",
      auth: { type: "api_key", key: "k", secret: "s" },
    },
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
 * from the `ccloud-oauth.yaml` fixture. Used by handler tests to assert that
 * handlers wrapped in `widenForOAuth(...)` see the connection as enabled and
 * that strict-predicate handlers see it as disabled. A stub
 * `OAuthClientManager` is supplied solely to satisfy `ServerRuntime`'s
 * constructor — `enabledConnectionIds()` reads `runtime.config.connections`
 * and never touches the client manager.
 */
export function ccloudOAuthRuntime(): ServerRuntime {
  const config = loadConfigFromYaml(CCLOUD_OAUTH_FIXTURE, {});
  return new ServerRuntime(config, {
    [CCLOUD_OAUTH_CONNECTION_ID]: createMockInstance(OAuthClientManager),
  });
}
