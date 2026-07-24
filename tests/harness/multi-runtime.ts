/**
 * Harness helpers for the #543 multi-connection integration suite.
 *
 * Mirrors runtime.ts / cp-runtime.ts but targets
 * test-fixtures/yaml_configs/integration.multi.yaml, which holds two `direct`
 * connections — `ccloud` (CCloud, the sole Flink-capable connection) and `cp`
 * (the local Confluent Platform broker, kafka only). The suite uses these to
 * prove tool calls route to the addressed connection against live infra.
 */

import { loadConfigFromYaml } from "@src/config/index.js";
import type { MCPServerConfiguration } from "@src/config/models.js";
import { type ConnectionConfig } from "@src/config/models.js";
import type { TransportType } from "@src/mcp/transports/types.js";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse, stringify } from "yaml";

const MULTI_FIXTURE_PATH = resolve(
  process.cwd(),
  "test-fixtures/yaml_configs/integration.multi.yaml",
);

/** The CCloud connection's id — the sole Flink-capable connection in the fixture. */
export const CCLOUD_CONNECTION_ID = "ccloud";

/** The local Confluent Platform broker connection's id — kafka only, no flink. */
export const CP_CONNECTION_ID = "cp";

/**
 * The {@link ConnectionConfig} the spawned MCP server would see for `connId`,
 * resolved by id from the multi fixture. The two-connection peer of
 * {@linkcode integrationConnection} in runtime.ts: a single connection is the
 * right-sized input for a {@linkcode ConnectionPredicate} gate, so a test gates
 * each connection it needs independently.
 *
 * On load failure (a required `${VAR}` missing — creds absent, or the CP broker's
 * static creds not present) returns an empty `direct` connection so the gate skips
 * cleanly. A loaded fixture missing `connId` is drift, not a creds-skip, and
 * {@linkcode MCPServerConfiguration.getConnectionConfig} throws loudly.
 */
export function multiIntegrationConnection(connId: string): ConnectionConfig {
  const config = tryLoadMultiConfig();
  if (config === undefined) return { type: "direct" };
  return config.getConnectionConfig(connId);
}

/**
 * Whether the multi fixture loaded — gating the suite on creds presence. Returns
 * `false` only when the YAML failed to load (a required `${VAR}` absent — creds
 * not configured), so a credential-less environment skips cleanly. A fixture
 * that loads but lacks an expected connection id is drift, not a creds-skip:
 * {@linkcode assertExpectedConnections} throws loudly rather than letting the
 * suite green-skip.
 */
export function multiIntegrationConnectionsLoaded(): boolean {
  const config = tryLoadMultiConfig();
  if (config === undefined) return false;
  assertExpectedConnections(config);
  return true;
}

/**
 * Asserts the loaded `config` holds both expected connection ids. A missing one
 * means the fixture drifted (a connection renamed or removed) — a real
 * regression that must fail loudly, never a silent skip. Split out (mirroring
 * `hasIntegrationConnection` in runtime.ts) so the drift check is unit-testable
 * against a directly-constructed config.
 */
export function assertExpectedConnections(
  config: MCPServerConfiguration,
): void {
  const ids = config.getConnectionIds();
  for (const required of [CCLOUD_CONNECTION_ID, CP_CONNECTION_ID]) {
    if (!ids.includes(required)) {
      throw new Error(
        `Multi-connection fixture loaded but missing connection id "${required}" ` +
          `(have: ${ids.join(", ") || "none"}). This is fixture drift in ` +
          `integration.multi.yaml, not a creds-skip.`,
      );
    }
  }
}

/**
 * Loads the multi fixture into an {@link MCPServerConfiguration}, or `undefined`
 * only when a required `${VAR}` is absent (creds not configured) — the clean
 * skip case. A malformed or schema-invalid fixture is a real regression and
 * propagates so CI fails loudly instead of green-skipping the suite. The seam
 * both {@linkcode multiIntegrationConnection} and
 * {@linkcode multiIntegrationConnectionsLoaded} build on.
 */
function tryLoadMultiConfig(): MCPServerConfiguration | undefined {
  try {
    return loadConfigFromYaml(MULTI_FIXTURE_PATH, process.env);
  } catch (error) {
    if (isMissingInterpolationVar(error)) return undefined;
    throw error;
  }
}

/**
 * True when `error` is {@linkcode loadConfigFromYaml}'s "a required `${VAR}` is
 * absent from env" failure — the expected creds-absent case the `@multi` gate
 * skips on. Every other load failure (malformed YAML, schema-invalid fixture)
 * is a regression that must propagate. Exported for the colocated unit test.
 */
export function isMissingInterpolationVar(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("Environment variable not found")
  );
}

export interface MultiSpawnConfigOptions {
  transport: TransportType;
  httpPort?: number;
  authDisabled?: boolean;
  apiKey?: string;
}

/**
 * Writes a per-spawn multi-connection config to a temp file, exactly like
 * {@linkcode spawnConfigPath} in runtime.ts but reading the multi fixture.
 * Returns the path the harness passes via `--config` to the spawned server.
 */
export function multiSpawnConfigPath(options: MultiSpawnConfigOptions): string {
  const parsed = parse(readFileSync(MULTI_FIXTURE_PATH, "utf-8")) as Record<
    string,
    unknown
  >;
  const server = {
    ...((parsed.server as Record<string, unknown> | undefined) ?? {}),
    transports: [options.transport],
  } as Record<string, unknown>;

  if (options.httpPort !== undefined) {
    const http = (server.http as Record<string, unknown> | undefined) ?? {};
    server.http = { ...http, port: options.httpPort };
  }

  if (options.authDisabled !== undefined || options.apiKey !== undefined) {
    const auth = (server.auth as Record<string, unknown> | undefined) ?? {};
    if (options.apiKey !== undefined) {
      auth.disabled = false;
      auth.api_key = options.apiKey;
    } else if (options.authDisabled !== undefined) {
      auth.disabled = options.authDisabled;
    }
    server.auth = auth;
  }

  parsed.server = server;
  const dir = mkdtempSync(join(tmpdir(), "mcp-confluent-multi-integration-"));
  const filePath = join(dir, "config.yaml");
  writeFileSync(filePath, stringify(parsed));
  return filePath;
}
