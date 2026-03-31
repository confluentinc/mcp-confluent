import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { logger } from "@src/logger.js";
import {
  pingHandler,
  pingRequestSchema,
  pingResponseSchema,
} from "@src/mcp/transports/ping.js";
import { HttpServer } from "@src/mcp/transports/server.js";
import { Transport } from "@src/mcp/transports/types.js";
import { randomUUID } from "crypto";
import { FastifyReply, FastifyRequest } from "fastify";

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
  private sessionServers: Record<string, McpServer> = {};

  constructor(
    private serverFactory: () => McpServer,
    private httpServer: HttpServer,
    private httpMcpEndpointPath: string = "/mcp",
  ) {}

  async connect(): Promise<void> {
    const fastify = this.httpServer.getInstance();

    // POST handler for new sessions and message sending
    fastify.post(
      this.httpMcpEndpointPath,
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
          // create the per-session server first so the onsessioninitialized
          // callback below doesn't reference a TDZ binding.
          const perSessionServer = this.serverFactory();
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid: string) => {
              this.sessions[sid] = transport;
              this.sessionServers[sid] = perSessionServer;
            },
          });

          await perSessionServer.connect(transport);
        }

        await transport.handleRequest(request.raw, reply.raw, request.body);
      },
    );

    // GET handler for session status and message receiving
    fastify.get(
      this.httpMcpEndpointPath,
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
      this.httpMcpEndpointPath,
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
        // clean up session transport and its server
        delete this.sessions[sessionId];
        transport.close();
        const server = this.sessionServers[sessionId];
        if (server) {
          await server.close();
          delete this.sessionServers[sessionId];
        }
      },
    );

    // POST ping endpoint for health checks
    fastify.post(
      "/ping",
      {
        schema: {
          tags: ["mcp"],
          summary: "JSON-RPC 2.0 ping endpoint",
          body: pingRequestSchema,
          response: {
            200: pingResponseSchema,
          },
        },
      },
      pingHandler(),
    );

    logger.info("HTTP transport routes registered");
  }

  async disconnect(): Promise<void> {
    logger.info("Cleaning up HTTP transport sessions...");
    // close all per-session servers
    for (const server of Object.values(this.sessionServers)) {
      await server.close();
    }
    this.sessionServers = {};
    // close all transports
    for (const transport of Object.values(this.sessions)) {
      transport.close();
    }
    this.sessions = {};
  }
}
