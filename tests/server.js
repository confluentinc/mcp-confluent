import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolFactory } from "@src/confluent/tools/tool-factory.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { initEnv } from "@src/env.js";
/**
 * Spins up an {@link McpServer} and {@link Client} connected via
 * {@link InMemoryTransport} for protocol-level integration tests.
 *
 * @param clientManager - (Stubbed) {@link ClientManager} injected into every
 *   tool handler
 * @param toolNames - (Optional) Subset of tools to register (defaults to all
 *   {@link ToolName} values)
 */
export async function createTestServer(clientManager, toolNames) {
  // ensure the env proxy is initialized so Zod .default() callbacks
  // in tool schemas (e.g., env.FLINK_REST_ENDPOINT) don't throw
  await initEnv();
  const server = new McpServer({
    name: "confluent-test",
    version: "0.0.0-test",
  });
  const names = toolNames ?? Object.values(ToolName);
  for (const toolName of names) {
    const handler = ToolFactory.createToolHandler(toolName);
    const config = handler.getToolConfig();
    server.registerTool(
      toolName,
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
