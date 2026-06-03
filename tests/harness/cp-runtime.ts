/**
 * Harness helpers for Confluent Platform integration tests.
 *
 * Mirrors runtime.ts but targets test-fixtures/yaml_configs/integration.cp.yaml
 * instead of integration.yaml, so CP tests can load and spawn from the CP
 * fixture without touching the CCloud fixture.
 */

import { loadConfigFromYaml } from "@src/config/index.js";
import { MCPServerConfiguration } from "@src/config/models.js";
import { TransportType } from "@src/mcp/transports/types.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse, stringify } from "yaml";

const CP_FIXTURE_PATH = resolve(
  process.cwd(),
  "test-fixtures/yaml_configs/integration.cp.yaml",
);

/**
 * The {@linkcode ServerRuntime} the spawned MCP server would see when using
 * the CP fixture. Same role as {@linkcode integrationRuntime} in runtime.ts
 * but reads from integration.cp.yaml. When the fixture fails to load (any
 * required `${VAR}` missing), returns an empty runtime so handlers' gates
 * yield a clean skip.
 */
export function cpIntegrationRuntime(): ServerRuntime {
  try {
    const config = loadConfigFromYaml(CP_FIXTURE_PATH, process.env);
    return ServerRuntime.fromConfig(config);
  } catch {
    return new ServerRuntime(
      new MCPServerConfiguration({ connections: {} }),
      {},
    );
  }
}

export interface CpSpawnConfigOptions {
  transport: TransportType;
  httpPort?: number;
  authDisabled?: boolean;
  apiKey?: string;
}

/**
 * Writes a per-spawn CP integration config to a temp file, exactly like
 * {@linkcode spawnConfigPath} in runtime.ts but reading from the CP fixture.
 * Returns the path the harness passes via `--config` to the spawned server.
 */
export function cpSpawnConfigPath(options: CpSpawnConfigOptions): string {
  const parsed = parse(readFileSync(CP_FIXTURE_PATH, "utf-8")) as Record<
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
  const dir = mkdtempSync(join(tmpdir(), "mcp-confluent-cp-integration-"));
  const filePath = join(dir, "config.yaml");
  writeFileSync(filePath, stringify(parsed));
  return filePath;
}
