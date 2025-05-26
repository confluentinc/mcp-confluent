import fastifyExpress from "@fastify/express";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import { logger } from "@src/logger.js";
import { ServerConfig } from "@src/mcp/transports/types.js";
import { RequestHandler } from "express";
import {
  default as Fastify,
  FastifyBaseLogger,
  FastifyInstance,
} from "fastify";

export class HttpServer {
  private fastify: FastifyInstance;
  private isSwaggerConfigured = false;
  constructor() {
    this.fastify = Fastify({
      loggerInstance: logger as FastifyBaseLogger,
      // Useful for when ongoing http/sse connections are present
      forceCloseConnections: true,
    });
    this.fastify.register(fastifyExpress);
  }

  async prepare(): Promise<void> {
    if (this.isSwaggerConfigured) {
      return;
    }

    // Configure Swagger before any routes are registered
    await this.fastify.register(fastifySwagger, {
      openapi: {
        info: {
          title: "Confluent MCP Server API",
          description: "API documentation for the Confluent MCP Server",
          version: "1.0.0",
        },
        servers: [
          {
            url: "http://localhost:3000",
            description: "Local development server",
          },
        ],
        components: {
          securitySchemes: {
            apiKey: {
              type: "apiKey",
              name: "X-API-Key",
              in: "header",
            },
          },
        },
        tags: [
          { name: "mcp", description: "Model Context Protocol endpoints" },
        ],
      },
      hideUntagged: false,
    });

    await this.fastify.register(fastifySwaggerUi, {
      routePrefix: "/documentation",
      uiConfig: {
        docExpansion: "list",
        deepLinking: true,
      },
      staticCSP: true,
    });

    this.isSwaggerConfigured = true;
  }

  getInstance(): FastifyInstance {
    return this.fastify;
  }

  async start(config: ServerConfig): Promise<void> {
    try {
      // Ready the server (this will compile the schemas and prepare all routes)
      await this.fastify.ready();

      // Start listening
      await this.fastify.listen({
        port: config.port,
        host: config.host,
      });
    } catch (error) {
      logger.error({ error }, "Failed to start server");
      throw error;
    }
  }

  async stop(): Promise<void> {
    try {
      logger.info("Shutting down server...");
      await this.fastify.close();
    } catch (error) {
      logger.error({ error }, "Error while shutting down server");
      throw error;
    }
  }

  async registerOAuthRouter(oauthRouter: RequestHandler) {
    this.fastify.use(oauthRouter);
  }
}
