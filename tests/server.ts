import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ClientManager } from "@src/confluent/client-manager.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ToolHandlerRegistry } from "@src/confluent/tools/tool-registry.js";
import { initEnv } from "@src/env.js";

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
 * @param clientManager - (Stubbed) {@link ClientManager} injected into every
 *   tool handler
 * @param toolNames - (Optional) Subset of tools to register (defaults to all
 *   {@link ToolName} values)
 */
export async function createTestServer(
  clientManager: ClientManager,
  toolNames?: ToolName[],
): Promise<TestServerContext> {
  // ensure the env proxy is initialized so Zod .default() callbacks
  // in tool schemas (e.g., env.FLINK_REST_ENDPOINT) don't throw
  await initEnv();

  const server = new McpServer({
    name: "confluent-test",
    version: "0.0.0-test",
  });

  const names = toolNames ?? Object.values(ToolName);
  for (const toolName of names) {
    const handler = ToolHandlerRegistry.getToolHandler(toolName);
    const config = handler.getToolConfig();
    server.registerTool(
      toolName as string,
      { description: config.description, inputSchema: config.inputSchema },
      async (args, context) => {
        return await handler.handle(clientManager, args, context?.sessionId);
      },
    );
  }

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
