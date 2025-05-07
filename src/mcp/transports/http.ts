import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { logger } from "@src/logger.js";
import { randomUUID } from "crypto";
import Fastify, { FastifyInstance } from "fastify";
import { BaseTransport } from "./base.js";
import { TransportConfig } from "./types.js";

export class HttpTransport extends BaseTransport {
  private fastify: FastifyInstance;
  private sessions: Record<string, StreamableHTTPServerTransport> = {};

  constructor(server: McpServer, config: TransportConfig) {
    super(server, config);
    this.fastify = Fastify();
    this.setupRoutes();
  }

  private setupRoutes(): void {
    this.fastify.post("/mcp", async (request, reply) => {
      const sessionId = request.headers["mcp-session-id"] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && this.sessions[sessionId]) {
        transport = this.sessions[sessionId];
      } else {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            this.sessions[sid] = transport;
          },
        });

        await this.server.connect(transport);
      }

      await transport.handleRequest(request.raw, reply.raw, request.body);
    });
  }

  async connect(): Promise<void> {
    await this.fastify.listen({
      port: this.config.port || 3000,
      host: this.config.host || "localhost",
    });

    logger.info(
      `Confluent MCP Server running on HTTP at ${this.config.host || "localhost"}:${this.config.port || 3000}`,
    );
  }

  async disconnect(): Promise<void> {
    logger.info("Shutting down HTTP server...");
    await this.fastify.close();
    // Clean up all active sessions
    Object.values(this.sessions).forEach((transport) => {
      if (transport.sessionId) {
        delete this.sessions[transport.sessionId];
      }
    });
  }
}
