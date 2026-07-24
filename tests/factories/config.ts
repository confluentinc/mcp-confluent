import type { MCPServerConfiguration } from "@src/config/models.js";
import { type DirectConnectionConfig } from "@src/config/models.js";
import { DEFAULT_CONNECTION_ID } from "@tests/factories/runtime.js";

/**
 * Reads the connection registered under `id` and narrows it to
 * {@link DirectConnectionConfig}, throwing if it is OAuth-typed. The by-id,
 * narrow-to-direct seam config-parser/builder tests use to read a fixture's
 * connection: `getConnectionConfig` returns the `ConnectionConfig` union, but
 * these tests assert on direct-only fields (`kafka`, `schema_registry`, …).
 *
 * `id` defaults to {@link DEFAULT_CONNECTION_ID} — the connection key the
 * single-connection `valid/*.yaml` fixtures and `tests/factories/runtime.ts`
 * both use. Pass an explicit id for synthesized configs that key on a different
 * constant (e.g. the env-var path's `DEFAULT_CONNECTION_ID`, `"_default"`).
 */
export function directConnectionOf(
  config: MCPServerConfiguration,
  id = DEFAULT_CONNECTION_ID,
): DirectConnectionConfig {
  const conn = config.getConnectionConfig(id);
  if (conn.type !== "direct") {
    throw new Error(
      `Expected connection "${id}" to be a direct connection; got type "${conn.type}"`,
    );
  }
  return conn;
}
