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
   * active and don't exercise the API-key middleware.
   */
  authDisabled?: boolean;
}

/**
 * The {@linkcode ServerRuntime} the spawned MCP server would see, given the
 * current `process.env`. Loaded via {@linkcode loadConfigFromYaml} from the
 * same fixture the harness rewrites for each spawn (minus the transport
 * injection, which gating doesn't depend on), so the test's view of
 * "configured" matches the server's by construction.
 *
 * Tests use this to gate via {@linkcode ToolHandler.enabledConnectionIds}
 * (the same predicate the server itself uses to decide whether to register
 * a tool). If the YAML fails to load (any required `${VAR}` missing), we
 * return an empty runtime so handlers' gates yield a clean skip with the
 * tool's `requiredConnectionPath` as the reason.
 */
export function integrationRuntime(): ServerRuntime {
  try {
    const config = loadConfigFromYaml(BASE_FIXTURE_PATH, process.env);
    return ServerRuntime.fromConfig(config);
  } catch {
    return new ServerRuntime(
      new MCPServerConfiguration({ connections: {} }),
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
  const parsed = parse(readFileSync(BASE_FIXTURE_PATH, "utf-8")) as Record<
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
  if (options.authDisabled !== undefined) {
    const auth = (server.auth as Record<string, unknown> | undefined) ?? {};
    server.auth = { ...auth, disabled: options.authDisabled };
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
