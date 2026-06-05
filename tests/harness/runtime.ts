import { loadConfigFromYaml } from "@src/config/index.js";
import {
  type ConnectionConfig,
  MCPServerConfiguration,
} from "@src/config/models.js";
import { TransportType } from "@src/mcp/transports/types.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse, stringify } from "yaml";

export interface SpawnConfigOptions {
  transport: TransportType;
  /**
   * HTTP port to bind. Required for HTTP and SSE transports; ignored for
   * stdio. The harness picks a free port via `findFreePort()` per spawn,
   * which has to flow into the YAML because `--config` is authoritative
   * over CLI flags / env vars on this code path.
   */
  httpPort?: number;
  /**
   * Whether to disable HTTP/SSE auth. Defaults to `true` for HTTP/SSE
   * spawns since tests run on loopback with DNS-rebinding protection still
   * active and don't exercise the API-key middleware. When `apiKey` is
   * supplied this is forced to `false` (the Zod schema rejects
   * `disabled: true` alongside an `api_key`).
   */
  authDisabled?: boolean;
  /**
   * Sets `server.auth.api_key` in the spawned config. Implies auth-enabled.
   * The auth smoke test uses this to exercise the API-key middleware
   * end-to-end; the routine kafka tests leave it unset and run with auth
   * disabled.
   */
  apiKey?: string;
  /** Use the OAuth YAML fixture ({@linkcode OAUTH_FIXTURE_PATH}) instead of the direct one. */
  oauth?: boolean;
}

/**
 * The {@linkcode ServerRuntime} the spawned MCP server would see, given the
 * current `process.env`. Loaded via {@linkcode loadConfigFromYaml} from the
 * same fixture the harness rewrites for each spawn (minus the transport
 * injection, which gating doesn't depend on), so the test's view of
 * "configured" matches the server's by construction.
 *
 * Used by the seeding harness helpers (kafka-admin, schema-registry, flink,
 * connect, confluent-cloud) that need per-connection config to build their own
 * api-key-authed clients. Per-handler skip gating moved to
 * {@linkcode integrationConnection} — a single connection is the right-sized
 * input for a {@linkcode ConnectionPredicate}, with no ServerRuntime to build.
 * If the YAML fails to load (any required `${VAR}` missing), returns an empty
 * runtime.
 */
export function integrationRuntime(
  options: { oauth?: boolean } = {},
): ServerRuntime {
  const fixturePath = options.oauth ? OAUTH_FIXTURE_PATH : BASE_FIXTURE_PATH;
  try {
    const config = loadConfigFromYaml(fixturePath, process.env);
    return ServerRuntime.fromConfig(config);
  } catch {
    return new ServerRuntime(
      new MCPServerConfiguration({ connections: {} }),
      {},
    );
  }
}

/**
 * The {@link ConnectionConfig} the spawned MCP server would see, looked up by
 * the fixture's connection name (see {@linkcode FIXTURE_CONNECTION_NAME}) in the
 * same fixture {@linkcode integrationRuntime} loads. Integration fixtures hold
 * exactly one connection, so this single connection is the right-sized input for
 * a {@linkcode ConnectionPredicate} gate: `handler.predicate(integrationConnection())`
 * answers "is this tool enabled?" without constructing a whole ServerRuntime.
 *
 * Resolves by id via {@linkcode MCPServerConfiguration.getConfig} rather than
 * `getSoleConnection()` — the #532 epic is removing the sole-connection accessors
 * repo-wide (see #541's completion bar), so new code must not depend on them.
 *
 * On load failure (a required `${VAR}` missing) or a missing connection returns
 * an empty `direct` connection, so every block-based predicate yields a clean
 * disabled verdict whose {@linkcode ToolDisabledReason} names the missing config.
 */
export function integrationConnection(
  options: { oauth?: boolean } = {},
): ConnectionConfig {
  const name = FIXTURE_CONNECTION_NAME[options.oauth ? "oauth" : "direct"];
  const fixturePath = options.oauth ? OAUTH_FIXTURE_PATH : BASE_FIXTURE_PATH;
  try {
    return loadConfigFromYaml(fixturePath, process.env).getConfig(name);
  } catch {
    // Either the fixture failed to load (a required `${VAR}` missing) or it
    // carries no connection by that name; an empty direct connection yields a
    // clean disabled verdict for the gate.
    return { type: "direct" };
  }
}

/**
 * Whether the integration fixture loaded at least one connection. The transport
 * smoke tests gate on this instead of a per-handler predicate: they need any
 * connection to exist (so the spawned server boots), not a specific service block.
 *
 * Counts connections rather than resolving the sole one, so it stays correct for
 * the multi-connection fixtures #543 introduces: a count answers "did anything
 * load?", whereas `getSoleConnection()` throws (and would wrongly read as "not
 * loaded") on more than one.
 */
export function integrationConnectionLoaded(
  options: { oauth?: boolean } = {},
): boolean {
  const config = tryLoadIntegrationConfig(options);
  return config !== undefined && hasIntegrationConnection(config);
}

/**
 * True when `config` carries at least one connection. Split out so the
 * multi-connection-safe existence check behind {@linkcode integrationConnectionLoaded}
 * is unit-testable against a directly-constructed multi-connection config.
 */
export function hasIntegrationConnection(
  config: MCPServerConfiguration,
): boolean {
  return Object.keys(config.connections).length > 0;
}

/**
 * Loads the chosen integration fixture into an {@link MCPServerConfiguration},
 * or `undefined` when the YAML fails to load (a required `${VAR}` missing). The
 * seam both {@linkcode integrationConnection} and {@linkcode integrationConnectionLoaded}
 * build on.
 */
function tryLoadIntegrationConfig(options: {
  oauth?: boolean;
}): MCPServerConfiguration | undefined {
  const fixturePath = options.oauth ? OAUTH_FIXTURE_PATH : BASE_FIXTURE_PATH;
  try {
    return loadConfigFromYaml(fixturePath, process.env);
  } catch {
    return undefined;
  }
}

/**
 * Writes a per-spawn integration config to a temp file: base fixture +
 * `server.transports = [transport]`, plus HTTP-specific fields when needed.
 * Returns the path the harness passes via `--config`.
 *
 * `--config` and `--transport` are mutually exclusive at the CLI level
 * (see `src/cli.ts`), so transport selection (and other server-level
 * settings the harness needs to inject per-spawn) has to live inside the
 * YAML.
 */
export function spawnConfigPath(options: SpawnConfigOptions): string {
  const fixturePath = options.oauth ? OAUTH_FIXTURE_PATH : BASE_FIXTURE_PATH;
  const parsed = parse(readFileSync(fixturePath, "utf-8")) as Record<
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
      // Zod refine rejects disabled=true + api_key=set, so force disabled=false
      auth.disabled = false;
      auth.api_key = options.apiKey;
    } else if (options.authDisabled !== undefined) {
      auth.disabled = options.authDisabled;
    }
    server.auth = auth;
  }
  parsed.server = server;
  const dir = mkdtempSync(join(tmpdir(), "mcp-confluent-integration-"));
  const filePath = join(dir, "config.yaml");
  writeFileSync(filePath, stringify(parsed));
  return filePath;
}

const BASE_FIXTURE_PATH = resolve(
  process.cwd(),
  "test-fixtures/yaml_configs/integration.yaml",
);

const OAUTH_FIXTURE_PATH = resolve(
  process.cwd(),
  "test-fixtures/yaml_configs/integration-oauth.yaml",
);

/**
 * The connection name each integration fixture gives its single connection.
 * {@linkcode integrationConnection} looks the connection up by this key rather
 * than via `getSoleConnection()`, which the #532 epic is removing repo-wide
 * (it encodes the single-connection assumption and throws once two exist).
 */
const FIXTURE_CONNECTION_NAME: Record<"direct" | "oauth", string> = {
  direct: "integration",
  oauth: "integration-oauth",
};
