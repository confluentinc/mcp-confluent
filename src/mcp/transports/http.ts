import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { sdkTransports } from "@src/confluent/node-deps.js";
import { logger } from "@src/logger.js";
import {
  pingHandler,
  pingRequestSchema,
  pingResponseSchema,
} from "@src/mcp/transports/ping.js";
import { HttpServer } from "@src/mcp/transports/server.js";
import { SessionRegistry } from "@src/mcp/transports/session-registry.js";
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
  private sessions = new SessionRegistry<StreamableHTTPServerTransport>();

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
            400: mcpErrorSchema,
            404: mcpErrorSchema,
          },
        },
      },
      async (
        request: FastifyRequest<{ Headers: McpRequestHeaders }>,
        reply: FastifyReply,
      ) => {
        const sessionId = request.headers["mcp-session-id"];

        if (sessionId) {
          const entry = this.sessions.get(sessionId);
          if (!entry) {
            reply.status(404).send({ error: "Session not found" });
            return;
          }
          await entry.transport.handleRequest(
            request.raw,
            reply.raw,
            request.body,
          );
          return;
        }

        // gate sessionless POSTs on init-body shape; the SDK's 400 path doesn't fire
        // onsessioninitialized or close the transport, which would leak a per-session McpServer
        if (!isInitializeRequest(request.body)) {
          reply.status(400).send({
            error:
              "Bad Request: Mcp-Session-Id header is required for non-initialize requests",
          });
          return;
        }

        const transport = await this.createSession();
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
        const entry = sessionId ? this.sessions.get(sessionId) : undefined;
        if (!entry) {
          reply.status(404).send({ error: "Session not found" });
          return;
        }

        await entry.transport.handleRequest(request.raw, reply.raw);
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
        const entry = sessionId ? this.sessions.get(sessionId) : undefined;
        if (!entry) {
          reply.status(404).send({ error: "Session not found" });
          return;
        }

        // the SDK's DELETE path closes the transport, which fires onclose (registered in POST)
        // where session + per-session-server cleanup actually happen
        await entry.transport.handleRequest(request.raw, reply.raw);
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
    await this.sessions.closeAll();
  }

  /**
   * Creates a fresh {@link McpServer} + {@link StreamableHTTPServerTransport} pair for an incoming
   * initialize POST, sets up session lifecycle callbacks, and binds the server.
   * NOTE: callers are responsible for forwarding the request to the returned transport
   */
  private async createSession(): Promise<StreamableHTTPServerTransport> {
    const perSessionServer = this.serverFactory();
    const transport = new sdkTransports.StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid: string) => {
        this.sessions.set(sid, { transport, server: perSessionServer });
      },
    });
    // fires on every close path (DELETE, network drop, server-initiated) so abandoned sessions
    // don't leak
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (!sid) return;
      this.sessions.closeAndRemove(sid).catch((err) => {
        logger.error(
          { err, sessionId: sid },
          "Failed to close session on transport.onclose",
        );
      });
    };

    await this.sessions.bindServer(perSessionServer, transport);
    return transport;
  }
}
