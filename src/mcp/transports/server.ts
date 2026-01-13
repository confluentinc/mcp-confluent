import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import env from "@src/env.js";
import { logger } from "@src/logger.js";
import { AuthConfig, createAuthHook } from "@src/mcp/transports/auth.js";
import { ServerConfig } from "@src/mcp/transports/types.js";
import {
  default as Fastify,
  FastifyBaseLogger,
  FastifyInstance,
} from "fastify";

/**
 * Configuration for the HTTP server
 */
export interface HttpServerConfig {
  /** Authentication configuration */
  auth?: AuthConfig;
}

export class HttpServer {
  private fastify: FastifyInstance;
  private isSwaggerConfigured = false;
  private authConfig: AuthConfig | null = null;

  constructor(config?: HttpServerConfig) {
    this.fastify = Fastify({
      loggerInstance: logger as FastifyBaseLogger,
      // Useful for when ongoing http/sse connections are present
      forceCloseConnections: true,
    });

    if (config?.auth) {
      this.authConfig = config.auth;
    }
  }

  async prepare(): Promise<void> {
    if (this.isSwaggerConfigured) {
      return;
    }

    // Register authentication hook BEFORE routes are registered
    if (this.authConfig) {
      this.fastify.addHook("onRequest", createAuthHook(this.authConfig));
      logger.info(
        { enabled: this.authConfig.enabled },
        "Authentication hook registered",
      );
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
            url: `http://${env.HTTP_HOST}:${env.HTTP_PORT}`,
            description: "Local development server",
          },
        ],
        components: {
          securitySchemes: {
            apiKey: {
              type: "apiKey",
              name: "cflt-mcp-api-Key",
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
}
