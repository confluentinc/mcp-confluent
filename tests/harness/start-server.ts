import { Client } from "@modelcontextprotocol/sdk/client/index.js";
// the MCP spec deprecated the SSE transport in favor of streamable HTTP, but we still ship SSE
// support, so integration tests need to keep exercising it until the server-side wiring is removed
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TransportType } from "@src/mcp/transports/types.js";
import { findFreePort } from "@tests/harness/find-port.js";
import { spawnConfigPath } from "@tests/harness/runtime.js";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";

export interface StartServerOptions {
  transport: TransportType;
  /**
   * Extra env vars merged over the parent process environment. Used for things
   * like overriding HTTP_PORT per-test or injecting tool-specific credentials.
   */
  env?: Record<string, string>;
}

export interface StartedServer {
  client: Client;
  /** Sends SIGTERM to the child, awaits exit, and closes the MCP client. */
  stop: () => Promise<void>;
}

// resolve from the worktree root (vitest runs with cwd at the project root)
const SERVER_ENTRY = resolve(process.cwd(), "dist/index.js");

// ───────────── Per-transport entry points ─────────────
// Function declarations are hoisted, so these can call the plumbing defined
// further down without forward-reference gymnastics.

/**
 * Spawns the MCP server as a child process and connects an SDK {@link Client}
 * over the requested transport. The caller is responsible for calling
 * {@linkcode StartedServer.stop} (typically from {@linkcode afterAll}) to tear
 * down both the client and the child process.
 */
export async function startServer(
  options: StartServerOptions,
): Promise<StartedServer> {
  switch (options.transport) {
    case TransportType.HTTP:
      return await startHttp(options);
    case TransportType.SSE:
      return await startSse(options);
    case TransportType.STDIO:
      return await startStdio(options);
  }
}

/**
 * Spawns the server on a free loopback port and connects via Streamable HTTP
 * at `/mcp`. Auth is disabled at the server level (DNS rebinding protection
 * still applies, so loopback + auth-disabled is safe).
 */
async function startHttp(options: StartServerOptions): Promise<StartedServer> {
  const port = await findFreePort();
  const child = await spawnHttpChild(options, port);

  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
  );
  const client = newClient();
  await client.connect(transport);

  return { client, stop: makeHttpStop(client, child) };
}

/**
 * Same shape as {@linkcode startHttp}, but connects via the deprecated SSE
 * transport at `/sse`. Both transports share one Fastify instance and one
 * auth hook server-side; the only client-side difference is the SDK
 * transport class and the endpoint path.
 */
async function startSse(options: StartServerOptions): Promise<StartedServer> {
  const port = await findFreePort();
  const child = await spawnHttpChild(options, port);

  // /sse matches the SSE_MCP_ENDPOINT_PATH default; the SDK transport opens an EventSource
  // against this URL, then routes outbound messages to the session-scoped /messages endpoint
  const transport = new SSEClientTransport(
    new URL(`http://127.0.0.1:${port}/sse`),
  );
  const client = newClient();
  await client.connect(transport);

  return { client, stop: makeHttpStop(client, child) };
}

/**
 * Spawns the server with stdio transport via the SDK's
 * {@linkcode StdioClientTransport}, which owns the child's spawn lifecycle
 * internally. The returned `stop()` peeks at the SDK's private child handle
 * so teardown awaits real exit, matching the HTTP/SSE path's symmetry.
 */
async function startStdio(options: StartServerOptions): Promise<StartedServer> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--no-deprecation",
      SERVER_ENTRY,
      "--config",
      spawnConfigPath({ transport: options.transport }),
    ],
    env: buildEnv(options.env),
    stderr: "inherit",
  });
  const client = newClient();
  await client.connect(transport);

  // Peek at the SDK's internal child reference so stop() can await its real
  // exit, matching the HTTP/SSE symmetry. Without this, transport.close()
  // sends the kill signal but returns before the child has actually exited,
  // so a later test file could race with a lingering child holding a
  // Kafka/CCloud connection.
  // TODO: drop the private-field peek once @modelcontextprotocol/sdk exposes
  // a public way to await child exit on StdioClientTransport (no such API
  // as of v1.x).
  const child = (transport as unknown as { _process?: ChildProcess })._process;

  // No SIGTERM here: client.close() routes through transport.close() which
  // already kills the SDK-owned child; we just await its exit afterward.
  const stop = async () => {
    await client.close();
    if (child && child.exitCode === null) {
      // ignore: once() can reject if the child emits "error" during teardown
      await once(child, "exit").catch(() => {});
    }
  };

  return { client, stop };
}

// ───────────── Plumbing ─────────────

/**
 * Merges `process.env` with caller overrides into a `Record<string, string>`
 * (`node:child_process` rejects undefined values). Forces
 * `NODE_ENV=integration` so `src/index.ts`'s test-mode guard lets `main()`
 * run, and defaults `LOG_LEVEL=error` because vitest's `test.env` doesn't
 * propagate across the `pool: "forks"` worker boundary.
 */
function buildEnv(
  overrides: Record<string, string> = {},
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") merged[key] = value;
  }
  // vitest sets NODE_ENV=test which trips src/index.ts's test guard, so override after the copy
  merged.NODE_ENV = "integration";
  // real failures (Zod env validation, CCloud auth, token-refresh) still surface at error level;
  // opt in to verbose via startServer({ env: { LOG_LEVEL: "debug" } })
  if (!merged.LOG_LEVEL) merged.LOG_LEVEL = "error";
  for (const [key, value] of Object.entries(overrides)) {
    merged[key] = value;
  }
  return merged;
}

/** The integration test's MCP client identity, shared across all transports. */
function newClient(): Client {
  return new Client({
    name: "mcp-confluent-integration",
    version: "0.0.0-test",
  });
}

/**
 * Polls the server's `/ping` endpoint until it returns 200, the child exits,
 * or {@linkcode timeoutMs} elapses. Captures combined stdout+stderr via the
 * caller-supplied accessor so a startup failure (bad CLI arg, Zod
 * validation, etc.) surfaces immediately instead of after the full timeout.
 */
async function waitForPing(
  url: string,
  child: ChildProcess,
  getOutput: () => string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    // short-circuit if the child already exited so the real startup error
    // surfaces immediately rather than after the full timeout
    if (child.exitCode !== null) {
      throw new Error(
        `server exited with code ${child.exitCode} before /ping was ready:\n${getOutput()}`,
      );
    }
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
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

/**
 * Spawn + wait-for-ready for the HTTP and SSE paths. Returns a connected
 * child or throws with the captured server output (which includes stdout
 * because pino logs there by default; stderr alone would miss a real
 * startup error). Disables auth on the spawned server because integration
 * tests run on loopback only and aren't trying to exercise the API-key
 * middleware.
 */
async function spawnHttpChild(
  options: StartServerOptions,
  port: number,
): Promise<ChildProcess> {
  const child: ChildProcess = spawn(
    process.execPath,
    [
      "--no-deprecation",
      SERVER_ENTRY,
      "--config",
      spawnConfigPath({
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
    if (child.exitCode === null) child.kill("SIGTERM");
    throw error;
  }
  return child;
}

/**
 * Teardown closure for the HTTP/SSE path: close the client, SIGTERM the
 * child if still alive, await exit so a later test file can't race with a
 * lingering child holding a Kafka/CCloud connection.
 */
function makeHttpStop(client: Client, child: ChildProcess) {
  return async () => {
    await client.close();
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
  };
}
