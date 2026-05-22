import { Client } from "@modelcontextprotocol/sdk/client/index.js";
// the MCP spec deprecated the SSE transport in favor of streamable HTTP, but we still ship SSE
// support, so integration tests need to keep exercising it until the server-side wiring is removed
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CFLT_MCP_API_KEY_HEADER } from "@src/mcp/transports/auth.js";
import { TransportType } from "@src/mcp/transports/types.js";
import { findFreePort } from "@tests/harness/find-port.js";
import { spawnConfigPath } from "@tests/harness/runtime.js";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import type { Readable } from "node:stream";

export interface StartServerOptions {
  transport: TransportType;
  /**
   * Extra env vars merged over the parent process environment. Used for things
   * like overriding HTTP_PORT per-test or injecting tool-specific credentials.
   */
  env?: Record<string, string>;
  /**
   * Enable HTTP/SSE auth on the spawned server with the given API key. When
   * set, the harness writes `server.auth.api_key` into the YAML, propagates
   * the {@linkcode CFLT_MCP_API_KEY_HEADER} through the `/ping` readiness
   * probe and the SDK client transport. Used by the auth smoke test; routine
   * tests omit this and run with auth disabled. Ignored for stdio.
   */
  auth?: { apiKey: string };
  /**
   * Spawn against the OAuth YAML fixture instead of the default direct one. Pipes child stderr
   * so {@linkcode driveOAuthFlow} can read the Auth0 authorization URL from it.
   */
  oauth?: boolean;
}

export interface StartedServer {
  client: Client;
  /**
   * Base URL of the spawned HTTP/SSE server (e.g. `http://127.0.0.1:51234`).
   * Undefined for stdio. Tests use this to send raw fetch requests
   * bypassing the SDK client (e.g. exercising the auth middleware with
   * deliberately-bad headers).
   */
  baseUrl?: string;
  /**
   * Child's stderr stream when {@linkcode StartServerOptions.oauth} is set, otherwise undefined.
   * Read by {@linkcode driveOAuthFlow} to extract the Auth0 authorization URL.
   */
  stderr?: Readable;
  /**
   * OAuth-only: returns a rolling string of everything the child has written to stderr since
   * spawn, capped at {@linkcode STDERR_SNAPSHOT_MAX_BYTES} with a `(truncated front)` marker.
   * Included in {@link driveOAuthFlow} timeout/exit error messages so a failed run shows what
   * the server actually logged instead of a generic 30s timeout.
   */
  stderrSnapshot?: () => string;
  /**
   * OAuth-only: resolves when the spawned child exits. {@link driveOAuthFlow} races this against
   * its auth-URL wait so a server that dies during OAuth init fails fast with the exit code +
   * captured stderr instead of timing out.
   */
  childExit?: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Sends SIGTERM to the child, awaits exit, and closes the MCP client. */
  stop: () => Promise<void>;
}

/** Cap for {@link createStderrCapture}: large enough to hold ~hundreds of pino JSON lines. */
const STDERR_SNAPSHOT_MAX_BYTES = 65_536;

/**
 * Attaches a data listener that accumulates stderr into a capped rolling string, and returns a
 * getter for it. Doubles as the drain that keeps the child from blocking on a full pipe buffer,
 * so this is the only stderr `data` listener needed on OAuth spawns.
 */
function createStderrCapture(stderr: Readable): () => string {
  let buf = "";
  stderr.on("data", (chunk: Buffer | string) => {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    if (buf.length > STDERR_SNAPSHOT_MAX_BYTES) {
      buf = "...(truncated front)...\n" + buf.slice(-STDERR_SNAPSHOT_MAX_BYTES);
    }
  });
  return () => buf;
}

/** Resolves with the child's exit `code` and `signal` once it exits. Never rejects. */
function captureChildExit(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

/**
 * Returns the `stderrSnapshot` + `childExit` pair on OAuth spawns, or an empty object otherwise.
 * Spread into the {@link StartedServer} literal so non-OAuth spawns stay byte-identical to the
 * pre-instrumentation shape.
 */
function oauthDiagnostics(
  options: StartServerOptions,
  child: ChildProcess | undefined,
): Pick<StartedServer, "stderrSnapshot" | "childExit"> {
  if (!options.oauth || !child?.stderr) return {};
  return {
    stderrSnapshot: createStderrCapture(child.stderr),
    childExit: captureChildExit(child),
  };
}

// resolve from the worktree root (vitest runs with cwd at the project root)
const SERVER_ENTRY = resolve(process.cwd(), "dist/index.js");

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
 * at `/mcp`. Auth is disabled at the server level by default (DNS rebinding
 * protection still applies, so loopback + auth-disabled is safe). When
 * `options.auth` is supplied, the spawned server requires the matching
 * {@linkcode CFLT_MCP_API_KEY_HEADER} value and the harness wires it into
 * the SDK transport so the connection still succeeds.
 */
async function startHttp(options: StartServerOptions): Promise<StartedServer> {
  const port = await findFreePort();
  const child = await spawnHttpChild(options, port);

  const baseUrl = `http://127.0.0.1:${port}`;
  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp`),
    options.auth
      ? { requestInit: { headers: authHeaders(options.auth.apiKey) } }
      : undefined,
  );
  const client = newClient();
  await client.connect(transport);

  return {
    client,
    baseUrl,
    stderr: options.oauth ? (child.stderr ?? undefined) : undefined,
    ...oauthDiagnostics(options, child),
    stop: makeHttpStop(client, child),
  };
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
  const baseUrl = `http://127.0.0.1:${port}`;
  const transport = new SSEClientTransport(
    new URL(`${baseUrl}/sse`),
    options.auth
      ? { requestInit: { headers: authHeaders(options.auth.apiKey) } }
      : undefined,
  );
  const client = newClient();
  await client.connect(transport);

  return {
    client,
    baseUrl,
    stderr: options.oauth ? (child.stderr ?? undefined) : undefined,
    ...oauthDiagnostics(options, child),
    stop: makeHttpStop(client, child),
  };
}

/** Header object the auth middleware checks (see {@linkcode CFLT_MCP_API_KEY_HEADER}). */
function authHeaders(apiKey: string): Record<string, string> {
  return { [CFLT_MCP_API_KEY_HEADER]: apiKey };
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
      spawnConfigPath({
        transport: options.transport,
        oauth: options.oauth,
      }),
    ],
    env: buildEnv(options.env),
    // pipe stderr only for OAuth spawns so `driveOAuthFlow` can read the auth URL; default
    // `inherit` keeps normal test output flowing to the parent terminal
    stderr: options.oauth ? "pipe" : "inherit",
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

  // OAuth spawns need a stderr drain so the child doesn't block on a full pipe buffer.
  // `createStderrCapture` (inside `oauthDiagnostics`) already attaches a `data` listener, which
  // doubles as that drain, so no separate keep-alive listener is needed here.
  const diagnostics = oauthDiagnostics(options, child);

  // No SIGTERM here: client.close() routes through transport.close() which
  // already kills the SDK-owned child; we just await its exit afterward.
  const stop = async () => {
    await client.close();
    if (child && child.exitCode === null) {
      // ignore: once() can reject if the child emits "error" during teardown
      await once(child, "exit").catch(() => {});
    }
  };

  return {
    client,
    stderr: options.oauth ? (child?.stderr ?? undefined) : undefined,
    ...diagnostics,
    stop,
  };
}

/**
 * Merges `process.env` with caller overrides into a `Record<string, string>`
 * (`node:child_process` rejects undefined values), forcing
 * `NODE_ENV=integration` so `src/index.ts`'s test-mode guard lets `main()`
 * run. Everything else the spawned server reads (transports, ports, auth,
 * log level) lives in the YAML fixture, not in env vars.
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
 *
 * `extraHeaders` is forwarded to the fetch — the auth middleware is global,
 * so when the spawn enables auth the readiness probe needs to send the same
 * {@linkcode CFLT_MCP_API_KEY_HEADER} as the SDK transport.
 */
async function waitForPing(
  url: string,
  child: ChildProcess,
  getOutput: () => string,
  timeoutMs = 30_000,
  extraHeaders: Record<string, string> = {},
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
        headers: { "content-type": "application/json", ...extraHeaders },
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
        authDisabled: !options.auth,
        apiKey: options.auth?.apiKey,
        oauth: options.oauth,
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
    await waitForPing(
      `http://127.0.0.1:${port}/ping`,
      child,
      () => outputBuf,
      undefined,
      options.auth ? authHeaders(options.auth.apiKey) : {},
    );
  } catch (error) {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      // await actual exit so the next test file doesn't race with a
      // lingering child holding the port; ignore errors emitted during
      // teardown (e.g. once() rejecting on an "error" event)
      await once(child, "exit").catch(() => {});
    }
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
      // ignore: once() rejects if the child emits "error" during teardown
      await once(child, "exit").catch(() => {});
    }
  };
}
