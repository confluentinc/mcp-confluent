import type { DirectConnectionConfig } from "@src/config/index.js";
import { MCPServerConfiguration } from "@src/config/models.js";
import { DirectClientManager } from "@src/confluent/direct-client-manager.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { createMockInstance, type HandleCase } from "@tests/stubs/index.js";
import type { Mocked } from "vitest";

/** Connection ID used by the named runtime factories and their default single-connection runtimes. */
export const DEFAULT_CONNECTION_ID = "default";

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

/** Extends HandleCase with a per-case connection config for handle() tests
 *  that need to vary the runtime shape (e.g. empty config for throw cases). */
export type HandleCaseWithConn = HandleCase & {
  connectionConfig?: Parameters<typeof runtimeWith>[0];
};

/**
 * Runtime whose `MCPServerConfiguration` carries the `ccloudOAuth` side-car set
 * (as the env-var `--oauth --oauth-env=devel` path produces) but whose connection
 * has no `confluent_cloud` block. Used to assert that block-presence predicates
 * (e.g. `hasConfluentCloud`) are *not* satisfied by the OAuth side-car alone —
 * i.e. tools gated on `confluent_cloud` stay disabled until the connection itself
 * carries the block. Does not populate `runtime.oauthHolder`; tests that need a
 * holder should construct one explicitly.
 */
export function ccloudOAuthRuntime(): ServerRuntime {
  return new ServerRuntime(
    new MCPServerConfiguration({
      connections: { [DEFAULT_CONNECTION_ID]: { type: "direct" } },
      ccloudOAuth: { type: "ccloud_oauth", env: "devel" },
    }),
    { [DEFAULT_CONNECTION_ID]: createMockInstance(DirectClientManager) },
  );
}
