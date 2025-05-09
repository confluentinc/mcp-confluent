import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { logger } from "@src/logger.js";
import { FastifyReply, FastifyRequest } from "fastify";
import { HttpServer } from "./server.js";
import { Transport } from "./types.js";

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
  private sessions: Map<string, SSEServerTransport> = new Map();

  constructor(
    private server: McpServer,
    private httpServer: HttpServer,
  ) {}

  async connect(): Promise<void> {
    const fastify = this.httpServer.getInstance();

    // SSE endpoint for establishing SSE connection
    fastify.get(
      "/sse",
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
          const transport = new SSEServerTransport("/messages", reply.raw);

          // Get the session ID from the transport
          const sessionId = transport.sessionId;
          if (!sessionId) {
            throw new Error("Failed to get session ID from transport");
          }

          // Store the session before connecting to ensure it's available for messages
          this.sessions.set(sessionId, transport);

          // Set up cleanup on connection close
          reply.raw.on("close", () => {
            logger.info(`SSE connection closed for session ${sessionId}`);
            this.sessions.delete(sessionId);
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
      "/messages",
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

          const transport = this.sessions.get(sessionId);

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

    logger.info("SSE transport routes registered");
  }

  async disconnect(): Promise<void> {
    logger.info("Cleaning up SSE transport sessions...");
    // Clean up all active sessions
    Object.values(this.sessions).forEach((transport) => {
      const sessionId = transport.sessionId;
      if (sessionId) {
        this.sessions.delete(sessionId);
      }
      transport.close();
    });
  }
}
