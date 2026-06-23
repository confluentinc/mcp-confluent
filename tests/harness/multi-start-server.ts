/**
 * Server-spawn helper for the #543 multi-connection integration suite.
 *
 * Mirrors cp-start-server.ts but passes {@linkcode multiSpawnConfigPath}, so the
 * spawned server reads the two-connection fixture (integration.multi.yaml) and
 * holds both the `ccloud` and `cp` connections at once.
 *
 * The public API — {@linkcode StartedServer} and {@linkcode startMultiServer} —
 * matches {@linkcode startServer} so test files only import from this module.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TransportType } from "@src/mcp/transports/types.js";
import { findFreePort } from "@tests/harness/find-port.js";
import { multiSpawnConfigPath } from "@tests/harness/multi-runtime.js";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";

// Re-export so multi-connection test files have a single import point.
export type { StartedServer } from "@tests/harness/start-server.js";

import type { StartedServer } from "@tests/harness/start-server.js";

const SERVER_ENTRY = resolve(process.cwd(), "dist/index.js");

export interface StartMultiServerOptions {
  transport: TransportType;
  env?: Record<string, string>;
}

/**
 * Spawns the MCP server against the multi-connection fixture and connects an SDK
 * {@link Client} over the requested transport. Mirrors {@linkcode startServer}
 * but points the server at integration.multi.yaml via
 * {@linkcode multiSpawnConfigPath}.
 *
 * Always call {@linkcode StartedServer.stop} in `afterAll`.
 */
export async function startMultiServer(
  options: StartMultiServerOptions,
): Promise<StartedServer> {
  switch (options.transport) {
    case TransportType.HTTP:
      return await startMultiHttp(options);
    case TransportType.SSE:
      return await startMultiSse(options);
    case TransportType.STDIO:
      return await startMultiStdio(options);
  }
}

async function startMultiHttp(
  options: StartMultiServerOptions,
): Promise<StartedServer> {
  const port = await findFreePort();
  const child = await spawnMultiHttpChild(options, port);

  const baseUrl = `http://127.0.0.1:${port}`;
  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp`),
  );
  const client = newClient();
  await client.connect(transport);

  return { client, baseUrl, stop: makeHttpStop(client, child) };
}

async function startMultiSse(
  options: StartMultiServerOptions,
): Promise<StartedServer> {
  const port = await findFreePort();
  const child = await spawnMultiHttpChild(options, port);

  const baseUrl = `http://127.0.0.1:${port}`;
  const transport = new SSEClientTransport(new URL(`${baseUrl}/sse`));
  const client = newClient();
  await client.connect(transport);

  return { client, baseUrl, stop: makeHttpStop(client, child) };
}

async function startMultiStdio(
  options: StartMultiServerOptions,
): Promise<StartedServer> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--no-deprecation",
      SERVER_ENTRY,
      "--config",
      multiSpawnConfigPath({ transport: options.transport }),
    ],
    env: buildEnv(options.env),
    stderr: "inherit",
  });
  const client = newClient();
  await client.connect(transport);

  const child = (transport as unknown as { _process?: ChildProcess })._process;

  const stop = async () => {
    await client.close();
    if (child && child.exitCode === null) {
      await once(child, "exit").catch(() => {});
    }
  };

  return { client, stop };
}

async function spawnMultiHttpChild(
  options: StartMultiServerOptions,
  port: number,
): Promise<ChildProcess> {
  const child: ChildProcess = spawn(
    process.execPath,
    [
      "--no-deprecation",
      SERVER_ENTRY,
      "--config",
      multiSpawnConfigPath({
        transport: options.transport,
        httpPort: port,
        authDisabled: true,
      }),
    ],
    {
      env: buildEnv(options.env),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let outputBuf = "";
  child.stdout?.on("data", (chunk) => {
    outputBuf += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    outputBuf += String(chunk);
  });

  try {
    await waitForPing(`http://127.0.0.1:${port}/ping`, child, () => outputBuf);
  } catch (error) {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit").catch(() => {});
    }
    throw error;
  }
  return child;
}

async function waitForPing(
  url: string,
  child: ChildProcess,
  getOutput: () => string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `server exited with code ${child.exitCode} before /ping was ready:\n${getOutput()}`,
      );
    }
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "ping" }),
      });
      if (response.ok) return;
      lastError = new Error(`ping returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `server /ping never became ready: ${String(lastError)}\n${getOutput()}`,
  );
}

function makeHttpStop(client: Client, child: ChildProcess) {
  return async () => {
    await client.close();
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit").catch(() => {});
    }
  };
}

function buildEnv(
  overrides: Record<string, string> = {},
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") merged[key] = value;
  }
  merged.NODE_ENV = "integration";
  for (const [key, value] of Object.entries(overrides)) {
    merged[key] = value;
  }
  return merged;
}

function newClient(): Client {
  return new Client({
    name: "mcp-confluent-multi-integration",
    version: "0.0.0-test",
  });
}
