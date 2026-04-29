import type { DirectConnectionConfig } from "@src/config/index.js";
import { MCPServerConfiguration } from "@src/config/models.js";
import { DefaultClientManager } from "@src/confluent/client-manager.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { envFactory } from "@tests/factories/env.js";
import { createMockInstance } from "@tests/stubs/index.js";

/** Connection ID used by the named runtime factories and their default single-connection runtimes. */
export const DEFAULT_CONNECTION_ID = "default";

/**
 * Creates a ServerRuntime with a mocked ClientManager and a customizable env.
 *
 * Pass `connectionConfig` to populate the connection's service blocks (kafka,
 * flink, schema_registry, etc.).
 *
 * For `enabledConnectionIds()` tests on handlers still using the shim (not yet
 * migrated to predicate form), supply matching env vars so the shim path passes.
 * For migrated handlers, env vars are irrelevant — prefer the named factory
 * functions (`bareRuntime()`, `schemaRegistryRuntime()`, etc.) which omit them.
 */
export function runtimeWith(
  env: ReturnType<typeof envFactory>,
  connectionConfig: Omit<DirectConnectionConfig, "type"> = {},
  connectionId = DEFAULT_CONNECTION_ID,
): ServerRuntime {
  return new ServerRuntime(
    new MCPServerConfiguration({
      connections: { [connectionId]: { type: "direct", ...connectionConfig } },
    }),
    { [connectionId]: createMockInstance(DefaultClientManager) },
    env,
  );
}

/** Runtime with no service blocks — the disabled case in enabledConnectionIds() tests. */
export function bareRuntime(): ServerRuntime {
  return runtimeWith(envFactory());
}

/** Runtime with a schema_registry block. */
export function schemaRegistryRuntime(): ServerRuntime {
  return runtimeWith(envFactory(), {
    schema_registry: { endpoint: "https://schema-registry.example.com" },
  });
}

/** Runtime with a confluent_cloud block. */
export function confluentCloudRuntime(): ServerRuntime {
  return runtimeWith(envFactory(), {
    confluent_cloud: {
      endpoint: "https://api.confluent.cloud",
      auth: { type: "api_key", key: "k", secret: "s" },
    },
  });
}

/** Runtime with a kafka block. */
export function kafkaRuntime(): ServerRuntime {
  return runtimeWith(envFactory(), {
    kafka: { bootstrap_servers: "broker:9092" },
  });
}

/** Runtime with a kafka block containing only a rest_endpoint (no bootstrap_servers) — the disabled case for admin-client handlers. */
export function kafkaRestOnlyRuntime(): ServerRuntime {
  return runtimeWith(envFactory(), {
    kafka: { rest_endpoint: "https://kafka-rest.example.com" },
  });
}

/** Runtime with a kafka block including a rest_endpoint and auth. */
export function kafkaRestRuntime(): ServerRuntime {
  return runtimeWith(envFactory(), {
    kafka: {
      bootstrap_servers: "broker:9092",
      rest_endpoint: "https://kafka-rest.example.com",
      auth: { type: "api_key", key: "k", secret: "s" },
    },
  });
}

/** Runtime with a tableflow block. */
export function tableflowRuntime(): ServerRuntime {
  return runtimeWith(envFactory(), {
    tableflow: { auth: { type: "api_key", key: "k", secret: "s" } },
  });
}

/** Runtime with a telemetry block. */
export function telemetryRuntime(): ServerRuntime {
  return runtimeWith(envFactory(), {
    telemetry: {
      endpoint: "https://api.telemetry.confluent.cloud",
      auth: { type: "api_key", key: "k", secret: "s" },
    },
  });
}
