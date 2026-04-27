import { Client } from "@modelcontextprotocol/sdk/client/index.js";
// the MCP spec deprecated the SSE transport in favor of streamable HTTP, but
// the server in this repo still ships SSE, so integration tests need to keep
// exercising it until the server-side wiring is removed.
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TransportType } from "@src/mcp/transports/types.js";
import { findFreePort } from "@tests/harness/find-port.js";
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

// resolve from the worktree root — vitest runs with cwd at the project root
const SERVER_ENTRY = resolve(process.cwd(), "dist/index.js");

function buildEnv(
  overrides: Record<string, string> = {},
): Record<string, string> {
  // merge parent env + overrides, filtering out undefined values so
  // TypeScript is happy with Record<string, string>.
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") merged[key] = value;
  }
  // force NODE_ENV after the parent-env copy because vitest sets NODE_ENV=test,
  // and src/index.ts guards main() with `if (process.env.NODE_ENV !== "test")`
  // — without this override the spawned child imports and exits without
  // starting the server.
  merged.NODE_ENV = "integration";
  // Default the server's log level to error so happy-path integration runs are
  // quiet. vitest.config.ts's `test.env: { LOG_LEVEL }` doesn't reliably
  // propagate through the `pool: "forks"` worker boundary into a child spawned
  // via node:child_process, so we set it here where the spawn env is explicit.
  // Real failures (Zod env validation, CCloud auth, token-refresh) still
  // surface at error level; tests that need verbose output can opt in via
  // `startServer({ env: { LOG_LEVEL: "debug" } })`.
  if (!merged.LOG_LEVEL) merged.LOG_LEVEL = "error";
  for (const [key, value] of Object.entries(overrides)) {
    merged[key] = value;
  }
  return merged;
}

async function waitForPing(
  url: string,
  child: ChildProcess,
  getStderr: () => string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    // short-circuit if the child exited — no point polling /ping if the
    // server is already gone. surfaces the real startup error (bad CLI arg,
    // zod validation failure, etc.) immediately instead of after 30s.
    if (child.exitCode !== null) {
      throw new Error(
        `server exited with code ${child.exitCode} before /ping was ready:\n${getStderr()}`,
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
    `server /ping never became ready: ${String(lastError)}\n${getStderr()}`,
  );
}

async function startHttp(options: StartServerOptions): Promise<StartedServer> {
  const port = await findFreePort();

  // integration tests run the client + server on loopback only. DNS rebinding
  // protection (MCP_ALLOWED_HOSTS) is always on, so disabling API key auth
  // just removes a header dance the tests aren't trying to exercise.
  const child: ChildProcess = spawn(
    process.execPath,
    ["--no-deprecation", SERVER_ENTRY, "--transport", TransportType.HTTP],
    {
      env: buildEnv({
        ...options.env,
        HTTP_PORT: String(port),
        MCP_AUTH_DISABLED: "true",
      }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  // buffer both stdout and stderr — pino logs to stdout by default, so
  // stderr alone would miss the real startup error if something fails.
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

  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
  );
  const client = new Client({
    name: "mcp-confluent-integration",
    version: "0.0.0-test",
  });
  await client.connect(transport);

  const stop = async () => {
    await client.close();
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
  };

  return { client, stop };
}

async function startSse(options: StartServerOptions): Promise<StartedServer> {
  const port = await findFreePort();

  // SSE shares the Fastify instance and HTTP_PORT with the streamable HTTP
  // transport server-side, and the same auth hook governs both, so the same
  // MCP_AUTH_DISABLED override removes the API-key header dance.
  const child: ChildProcess = spawn(
    process.execPath,
    ["--no-deprecation", SERVER_ENTRY, "--transport", TransportType.SSE],
    {
      env: buildEnv({
        ...options.env,
        HTTP_PORT: String(port),
        MCP_AUTH_DISABLED: "true",
      }),
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

  // /sse matches the SSE_MCP_ENDPOINT_PATH default; the SDK transport opens
  // the EventSource against this URL, then routes outbound messages to the
  // session-scoped /messages endpoint (handled inside the SDK).
  const transport = new SSEClientTransport(
    new URL(`http://127.0.0.1:${port}/sse`),
  );
  const client = new Client({
    name: "mcp-confluent-integration",
    version: "0.0.0-test",
  });
  await client.connect(transport);

  const stop = async () => {
    await client.close();
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
  };

  return { client, stop };
}

async function startStdio(options: StartServerOptions): Promise<StartedServer> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--no-deprecation",
      SERVER_ENTRY,
      "--transport",
      TransportType.STDIO,
    ],
    env: buildEnv(options.env),
    stderr: "inherit",
  });
  const client = new Client({
    name: "mcp-confluent-integration",
    version: "0.0.0-test",
  });
  await client.connect(transport);

  // the SDK spawns the child internally and keeps it in a private field;
  // peek at it so stop() can await exit symmetrically with the HTTP path.
  // without this, StdioClientTransport.close() sends the kill signal but
  // returns before the child has actually exited — a later test file could
  // then race with a lingering child holding a Kafka/CCloud connection.
  const child = (transport as unknown as { _process?: ChildProcess })._process;

  const stop = async () => {
    await client.close();
    if (child && child.exitCode === null) {
      await once(child, "exit").catch(() => {
        /* child already gone */
      });
    }
  };

  return { client, stop };
}

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
