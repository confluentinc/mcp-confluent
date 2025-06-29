import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { logger } from "@src/logger.js";
import {
  pingHandler,
  pingRequestSchema,
  pingResponseSchema,
} from "@src/mcp/transports/ping.js";
import { HttpServer } from "@src/mcp/transports/server.js";
import { Transport } from "@src/mcp/transports/types.js";
import { FastifyReply, FastifyRequest } from "fastify";

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
  private sessions: Record<string, SSEServerTransport> = {};

  constructor(
    private server: McpServer,
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
      async (request: FastifyRequest, reply: FastifyReply) => {
        try {
          // Create transport with the correct message endpoint
          const transport = new SSEServerTransport(
            this.sseMcpMessageEndpointPath,
            reply.raw,
          );

          // Get the session ID from the transport
          const sessionId = transport.sessionId;
          if (!sessionId) {
            throw new Error("Failed to get session ID from transport");
          }

          // Store the session before connecting to ensure it's available for messages
          this.sessions[sessionId] = transport;

          // Set up cleanup on connection close
          reply.raw.on("close", () => {
            logger.info(`SSE connection closed for session ${sessionId}`);
            delete this.sessions[sessionId];
          });

          // Connect the transport to the server
          await this.server.connect(transport);

          logger.info(
            `New SSE connection established for session ${sessionId}`,
          );
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
          logger.info(`Received message for sessionId ${sessionId}`);

          const transport = this.sessions[sessionId];

          if (!transport) {
            logger.warn(`No transport found for sessionId: ${sessionId}`);
            reply.code(400).send({ error: "No transport found for sessionId" });
            return;
          }

          await transport.handlePostMessage(
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
