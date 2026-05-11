import { DEFAULT_CONNECTION_NAME } from "@src/config/env-config.js";
import { loadConfigFromYaml } from "@src/config/index.js";
import { MCPServerConfiguration } from "@src/config/models.js";
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
}

/**
 * The {@linkcode ServerRuntime} the spawned MCP server would see, given the
 * current `process.env`. Loaded via {@linkcode loadConfigFromYaml} from the
 * same fixture the harness rewrites for each spawn (minus the transport
 * injection, which gating doesn't depend on), so the test's view of
 * "configured" matches the server's by construction.
 *
 * Tests use this with {@linkcode ToolHandler.enabledConnectionIds} as a
 * skip gate. If `${VAR}` interpolation fails, we return a placeholder
 * direct connection so connection-agnostic tests (doc tools, smoke) run
 * without credentials; cred-gated predicates still skip.
 */
export function integrationRuntime(): ServerRuntime {
  try {
    const config = loadConfigFromYaml(BASE_FIXTURE_PATH, process.env);
    return ServerRuntime.fromConfig(config);
  } catch (err) {
    if (!isInterpolationError(err)) throw err;
    return new ServerRuntime(
      new MCPServerConfiguration({
        connections: { [DEFAULT_CONNECTION_NAME]: { type: "direct" } },
      }),
      {},
    );
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
  // Mirror integrationRuntime()'s fallback. Cred-gated tests have already
  // skipped via their own gate before reaching this path.
  let parsed: Record<string, unknown>;
  try {
    loadConfigFromYaml(BASE_FIXTURE_PATH, process.env);
    parsed = parse(readFileSync(BASE_FIXTURE_PATH, "utf-8")) as Record<
      string,
      unknown
    >;
  } catch (err) {
    if (!isInterpolationError(err)) throw err;
    parsed = { connections: { [DEFAULT_CONNECTION_NAME]: { type: "direct" } } };
  }
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

/**
 * True only for `${VAR}` interpolation failures. YAML syntax, Zod, and
 * missing-file errors must rethrow so broken fixtures fail loudly.
 */
function isInterpolationError(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.message.includes("Failed to interpolate configuration values")
  );
}
