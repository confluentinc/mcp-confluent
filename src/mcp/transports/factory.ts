import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BaseTransport } from "./base.js";
import { HttpTransport } from "./http.js";
import { StdioTransport } from "./stdio.js";
import { TransportConfig, TransportType } from "./types.js";

export class TransportFactory {
  private static transports: Map<
    TransportType,
    new (server: McpServer, config: TransportConfig) => BaseTransport
  > = new Map([
    [TransportType.STDIO, StdioTransport],
    [TransportType.HTTP, HttpTransport],
  ]);

  static createTransport(
    type: TransportType,
    server: McpServer,
    config: TransportConfig,
  ): BaseTransport {
    const TransportClass = this.transports.get(type);
    if (!TransportClass) {
      throw new Error(`Unsupported transport type: ${type}`);
    }
    return new TransportClass(server, config);
  }
}
