import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolHandler } from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ToolHandlerRegistry } from "@src/confluent/tools/tool-registry.js";
import { initEnv } from "@src/env.js";
import { createMcpServer } from "@src/mcp/server.js";
import { ServerRuntime } from "@src/server-runtime.js";

export interface TestServerContext {
  server: McpServer;
  client: Client;
  clientTransport: InMemoryTransport;
  serverTransport: InMemoryTransport;
  /** Closes the client and server transports. Call in {@linkcode afterEach}. */
  shutdown: () => Promise<void>;
}

/**
 * Spins up an {@link McpServer} and {@link Client} connected via
 * {@link InMemoryTransport} for protocol-level integration tests.
 *
 * Tool registration delegates to the production {@linkcode createMcpServer} so this helper can't
 * drift from the real server's wiring.
 *
 * @param runtime - {@link ServerRuntime} injected into every tool handler
 * @param toolNames - (Optional) Subset of tools to register (defaults to all
 *   {@link ToolName} values)
 */
export async function createTestServer(
  runtime: ServerRuntime,
  toolNames?: ToolName[],
): Promise<TestServerContext> {
  // ensure the env proxy is initialized so Zod .default() callbacks
  // in tool schemas (e.g., env.FLINK_REST_ENDPOINT) don't throw
  await initEnv();

  const names = toolNames ?? Object.values(ToolName);
  const toolHandlers = new Map<ToolName, ToolHandler>(
    names.map((name) => [name, ToolHandlerRegistry.getToolHandler(name)]),
  );

  const server = createMcpServer({
    serverVersion: "0.0.0-test",
    toolHandlers,
    runtime,
  });

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0-test" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const shutdown = async () => {
    await client.close();
    await server.close();
  };

  return { server, client, clientTransport, serverTransport, shutdown };
}
