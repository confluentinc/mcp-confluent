import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "@src/logger.js";
import { HttpTransport } from "@src/mcp/transports/http.js";
import { HttpServer } from "@src/mcp/transports/server.js";
import { SseTransport } from "@src/mcp/transports/sse.js";
import { StdioTransport } from "@src/mcp/transports/stdio.js";
import { Transport, TransportType } from "@src/mcp/transports/types.js";

export class TransportManager {
  private transports: Map<TransportType, Transport> = new Map();
  private httpServer: HttpServer | null = null;

  constructor(private server: McpServer) {}

  async start(
    types: TransportType[],
    port?: number,
    host?: string,
  ): Promise<void> {
    try {
      const needsHttpServer = types.some(
        (type) => type === TransportType.HTTP || type === TransportType.SSE,
      );

      // Initialize and prepare HTTP server if needed
      if (needsHttpServer) {
        this.httpServer = new HttpServer();
        await this.httpServer.prepare();
      }

      // Create and connect all transports
      await Promise.all(
        types.map(async (type) => {
          const transport = await this.createTransport(type);
          this.transports.set(type, transport);
          await transport.connect();
        }),
      );

      // Start HTTP server if needed (after routes are registered)
      if (needsHttpServer && this.httpServer) {
        if (port && host) {
          await this.httpServer.start({
            port,
            host,
          });
        } else {
          logger.error("Port and host are required");
          throw new Error("Port and host are required");
        }
      }

      logger.info("All transports started successfully");
    } catch (error) {
      logger.error({ error }, "Failed to start transports");
      // Clean up any partially started transports
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    // Stop HTTP server first to prevent new requests
    if (this.httpServer) {
      await this.httpServer.stop();
    }

    // Then disconnect all transports
    await Promise.all(
      Array.from(this.transports.values()).map(async (transport) => {
        try {
          await transport.disconnect();
        } catch (error) {
          logger.error(
            { error },
            `Failed to disconnect transport: ${transport.constructor.name}`,
          );
        }
      }),
    );

    this.transports.clear();
    this.httpServer = null;
  }

  private async createTransport(type: TransportType): Promise<Transport> {
    switch (type) {
      case "http":
        if (!this.httpServer) {
          throw new Error("HTTP server not initialized");
        }
        return new HttpTransport(this.server, this.httpServer);
      case "sse":
        if (!this.httpServer) {
          throw new Error("HTTP server not initialized");
        }
        return new SseTransport(this.server, this.httpServer);
      case "stdio":
        return new StdioTransport(this.server);
      default:
        throw new Error(`Unsupported transport type: ${type}`);
    }
  }
}
