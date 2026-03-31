import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ClientManager } from "@src/confluent/client-manager.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
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
export declare function createTestServer(
  clientManager: ClientManager,
  toolNames?: ToolName[],
): Promise<TestServerContext>;
