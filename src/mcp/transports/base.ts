import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TransportConfig } from "./types.js";

export abstract class BaseTransport {
  protected server: McpServer;
  protected config: TransportConfig;

  constructor(server: McpServer, config: TransportConfig) {
    this.server = server;
    this.config = config;
  }

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
}
