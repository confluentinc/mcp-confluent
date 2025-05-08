import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { logger } from "@src/logger.js";
import { randomUUID } from "crypto";
import { FastifyReply, FastifyRequest } from "fastify";
import { HttpServer } from "./server.js";
import { Transport } from "./types.js";

interface McpRequestHeaders {
  "mcp-session-id"?: string;
}

const mcpSessionSchema = {
  type: "object",
  properties: {
    sessionId: { type: "string", format: "uuid" },
  },
};

const mcpErrorSchema = {
  type: "object",
  properties: {
    error: { type: "string" },
  },
};

export class HttpTransport implements Transport {
  private sessions: Record<string, StreamableHTTPServerTransport> = {};

  constructor(
    private server: McpServer,
    private httpServer: HttpServer,
  ) {}

  async connect(): Promise<void> {
    const fastify = this.httpServer.getInstance();

    // POST handler for new sessions and message sending
    fastify.post(
      "/mcp",
      {
        schema: {
          tags: ["mcp"],
          summary: "Create a new MCP session or send a message",
          headers: {
            type: "object",
            properties: {
              "mcp-session-id": { type: "string", format: "uuid" },
            },
          },
          response: {
            200: mcpSessionSchema,
            404: mcpErrorSchema,
          },
        },
      },
      async (
        request: FastifyRequest<{ Headers: McpRequestHeaders }>,
        reply: FastifyReply,
      ) => {
        const sessionId = request.headers["mcp-session-id"];
        let transport: StreamableHTTPServerTransport;

        if (sessionId && this.sessions[sessionId]) {
          transport = this.sessions[sessionId];
        } else {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid: string) => {
              this.sessions[sid] = transport;
            },
          });

          await this.server.connect(transport);
        }

        await transport.handleRequest(request.raw, reply.raw, request.body);
      },
    );

    // GET handler for session status and message receiving
    fastify.get(
      "/mcp",
      {
        schema: {
          tags: ["mcp"],
          summary: "Get session status or receive messages",
          headers: {
            type: "object",
            properties: {
              "mcp-session-id": { type: "string", format: "uuid" },
            },
            required: ["mcp-session-id"],
          },
          response: {
            200: mcpSessionSchema,
            404: mcpErrorSchema,
          },
        },
      },
      async (
        request: FastifyRequest<{ Headers: McpRequestHeaders }>,
        reply: FastifyReply,
      ) => {
        const sessionId = request.headers["mcp-session-id"];
        if (!sessionId || !this.sessions[sessionId]) {
          reply.status(404).send({ error: "Session not found" });
          return;
        }

        const transport = this.sessions[sessionId];
        await transport.handleRequest(request.raw, reply.raw);
      },
    );

    // DELETE handler for session cleanup
    fastify.delete(
      "/mcp",
      {
        schema: {
          tags: ["mcp"],
          summary: "Delete an MCP session",
          headers: {
            type: "object",
            properties: {
              "mcp-session-id": { type: "string", format: "uuid" },
            },
            required: ["mcp-session-id"],
          },
          response: {
            200: mcpSessionSchema,
            404: mcpErrorSchema,
          },
        },
      },
      async (
        request: FastifyRequest<{ Headers: McpRequestHeaders }>,
        reply: FastifyReply,
      ) => {
        const sessionId = request.headers["mcp-session-id"];
        if (!sessionId || !this.sessions[sessionId]) {
          reply.status(404).send({ error: "Session not found" });
          return;
        }

        const transport = this.sessions[sessionId];
        await transport.handleRequest(request.raw, reply.raw);
        // Clean up the session
        delete this.sessions[sessionId];
      },
    );

    logger.info("HTTP transport routes registered");
  }

  async disconnect(): Promise<void> {
    logger.info("Cleaning up HTTP transport sessions...");
    // Clean up all active sessions
    Object.values(this.sessions).forEach((transport) => {
      const sessionId = transport.sessionId;
      if (sessionId) {
        delete this.sessions[sessionId];
      }
      transport.close();
    });
  }
}
