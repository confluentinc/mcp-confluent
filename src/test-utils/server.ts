import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ClientManager } from "@src/confluent/client-manager.js";
import { ToolFactory } from "@src/confluent/tools/tool-factory.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { initEnv } from "@src/env.js";

export interface TestServerContext {
  server: McpServer;
  client: Client;
  clientTransport: InMemoryTransport;
  serverTransport: InMemoryTransport;
}

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
    const handler = ToolFactory.createToolHandler(toolName);
    const config = handler.getToolConfig();
    server.tool(
      toolName as string,
      config.description,
      config.inputSchema,
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

  return { server, client, clientTransport, serverTransport };
}
