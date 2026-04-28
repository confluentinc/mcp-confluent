import type { DirectConnectionConfig } from "@src/config/index.js";
import { MCPServerConfiguration } from "@src/config/models.js";
import { DefaultClientManager } from "@src/confluent/client-manager.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { envFactory } from "@tests/factories/env.js";
import { createMockInstance } from "@tests/stubs/index.js";

/**
 * Creates a ServerRuntime with a mocked ClientManager and a customizable env.
 *
 * Pass `connectionConfig` to populate the connection's service blocks (kafka,
 * flink, schema_registry, etc.). Tests for `enabledConnectionIds()` should
 * supply both the relevant env vars (for the current shim) and the matching
 * service block (for the post-migration predicate), so the test survives the
 * issue-173 migration without modification.
 */
export function runtimeWith(
  env: ReturnType<typeof envFactory>,
  connectionConfig: Omit<DirectConnectionConfig, "type"> = {},
  connectionId = "default",
): ServerRuntime {
  return new ServerRuntime(
    new MCPServerConfiguration({
      connections: { [connectionId]: { type: "direct", ...connectionConfig } },
    }),
    { [connectionId]: createMockInstance(DefaultClientManager) },
    env,
  );
}
