import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
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
import { FastifyReply, FastifyRequest } from "fastify";
import { ServerResponse } from "node:http";

interface SseMessageRequest {
  Querystring: {
    sessionId: string;
  };
  Body: unknown;
}

const sseErrorSchema = {
  type: "object",
  properties: {
    error: { type: "string" },
  },
};

export class SseTransport implements Transport {
  private sessions = new SessionRegistry<SSEServerTransport>();

  constructor(
    private serverFactory: () => McpServer,
    private httpServer: HttpServer,
    private sseMcpEndpointPath: string = "/sse",
    private sseMcpMessageEndpointPath: string = "/messages",
  ) {}

  async connect(): Promise<void> {
    const fastify = this.httpServer.getInstance();

    // SSE endpoint for establishing SSE connection
    fastify.get(
      this.sseMcpEndpointPath,
      {
        schema: {
          tags: ["mcp"],
          summary: "Establish SSE connection for real-time updates",
          response: {
            400: sseErrorSchema,
          },
        },
      },
      async (_request: FastifyRequest, reply: FastifyReply) => {
        try {
          await this.createSession(reply.raw);
        } catch (error) {
          logger.error({ error }, "Failed to establish SSE connection");
          if (!reply.sent) {
            reply
              .code(400)
              .send({ error: "Failed to establish SSE connection" });
          }
        }
      },
    );

    // Message endpoint for receiving messages from clients
    fastify.post(
      this.sseMcpMessageEndpointPath,
      {
        schema: {
          tags: ["mcp"],
          summary: "Send message to SSE connection",
          querystring: {
            type: "object",
            required: ["sessionId"],
            properties: {
              sessionId: { type: "string", format: "uuid" },
            },
          },
          body: {
            type: "object",
            additionalProperties: true,
          },
          response: {
            400: sseErrorSchema,
          },
        },
      },
      async (
        request: FastifyRequest<SseMessageRequest>,
        reply: FastifyReply,
      ) => {
        try {
          const sessionId = request.query.sessionId;
          const entry = this.sessions.get(sessionId);

          if (!entry) {
            logger.warn(`No transport found for sessionId: ${sessionId}`);
            reply.code(400).send({ error: "No transport found for sessionId" });
            return;
          }

          await entry.transport.handlePostMessage(
            request.raw,
            reply.raw,
            request.body,
          );
        } catch (error) {
          logger.error({ error }, "Failed to process SSE message");
          if (!reply.sent) {
            reply.code(400).send({ error: "Failed to process message" });
          }
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

    logger.info("SSE transport routes registered");
  }

  async disconnect(): Promise<void> {
    logger.info("Cleaning up SSE transport sessions...");
    await this.sessions.closeAll();
  }

  /**
   * Mints a per-session {@link McpServer} + {@link SSEServerTransport} pair, wires
   * lifecycle callbacks, registers the session, then binds the server. Streamable HTTP gets
   * the sessionId asynchronously via the SDK's {@linkcode onsessioninitialized} callback (which
   * fires inside {@linkcode StreamableHTTPServerTransport.handleRequest}), so it can register
   * lazily and a failed bind leaves no entry. SSE has no such callback — sessionId is known at
   * construction — so we register first and roll back on bind rejection. Without the rollback
   * a fast client could see {@linkcode SSEServerTransport.start}'s endpoint event, POST to
   * {@linkcode sseMcpMessageEndpointPath} and race the {@linkcode sessions.set} call.
   */
  private async createSession(
    rawResponse: ServerResponse,
  ): Promise<SSEServerTransport> {
    const perSessionServer = this.serverFactory();
    const transport = new sdkTransports.SSEServerTransport(
      this.sseMcpMessageEndpointPath,
      rawResponse,
    );
    const sessionId = transport.sessionId;
    if (!sessionId) {
      throw new Error("Failed to get session ID from transport");
    }

    // fires on every close path (network drop, server-initiated, etc.) so abandoned sessions
    // don't leak; closeAndRemove is idempotent against the not-yet-registered case
    transport.onclose = () => {
      this.sessions.closeAndRemove(sessionId).catch((err) => {
        logger.error(
          { err, sessionId },
          "Failed to close SSE session on transport.onclose",
        );
      });
    };

    this.sessions.set(sessionId, {
      transport,
      server: perSessionServer,
    });
    try {
      await this.sessions.bindServer(perSessionServer, transport);
    } catch (err) {
      // bindServer already closed both halves via its internal closeEntry; we still call
      // closeAndRemove here because bindServer doesn't know the registry key and the entry
      // is what makes the session reachable to incoming POSTs. The duplicate close is safe:
      // SDK transport.close() and McpServer.close() are both idempotent.
      await this.sessions.closeAndRemove(sessionId);
      throw err;
    }

    logger.info(`New SSE connection established for session ${sessionId}`);
    return transport;
  }
}
