import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { logger } from "@src/logger.js";
import { BaseTransport } from "./base.js";

export class StdioTransport extends BaseTransport {
  private transport?: StdioServerTransport;

  async connect(): Promise<void> {
    this.transport = new StdioServerTransport();
    await this.server.connect(this.transport);
    logger.info("Confluent MCP Server running on stdio");
  }

  async disconnect(): Promise<void> {
    // Stdio transport doesn't need explicit cleanup
  }
}
