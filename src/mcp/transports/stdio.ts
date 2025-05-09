import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { logger } from "@src/logger.js";
import { Transport } from "@src/mcp/transports/types.js";

export class StdioTransport implements Transport {
  constructor(private server: McpServer) {}

  async connect(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.info("STDIO transport connected");
  }

  async disconnect(): Promise<void> {
    // Nothing to clean up for stdio transport
  }
}
