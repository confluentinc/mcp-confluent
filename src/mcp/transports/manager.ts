import { ProxyOAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/providers/proxyProvider.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "@src/logger.js";
import { HttpTransport } from "@src/mcp/transports/http.js";
import { HttpServer } from "@src/mcp/transports/server.js";
import { SseTransport } from "@src/mcp/transports/sse.js";
import { StdioTransport } from "@src/mcp/transports/stdio.js";
import { Transport, TransportType } from "@src/mcp/transports/types.js";

export type OAuthEnv = {
  OAUTH_AUTHORIZATION_URL: string;
  OAUTH_TOKEN_URL: string;
  OAUTH_REVOCATION_URL: string;
  OAUTH_ISSUER_URL: string;
  OAUTH_BASE_URL: string;
  OAUTH_DOCS_URL: string;
  OAUTH_REDIRECT_URI: string;
  OAUTH_CLIENT_ID: string;
  OAUTH_SCOPES: string[];
};

type TransportManagerOptions = {
  enableOAuth?: boolean;
  oauthConfig?: OAuthEnv;
};

export class TransportManager {
  private transports: Map<TransportType, Transport> = new Map();
  private httpServer: HttpServer | null = null;
  private options: TransportManagerOptions;

  constructor(
    private server: McpServer,
    options: TransportManagerOptions = {},
  ) {
    this.options = options;
  }

  async start(
    types: TransportType[],
    port?: number,
    host?: string,
  ): Promise<void> {
    try {
      const needsHttpServer = types.some(
        (type) => type === TransportType.HTTP || type === TransportType.SSE,
      );

      if (needsHttpServer) {
        this.httpServer = new HttpServer();
        await this.httpServer.prepare();

        // Register OAuth router if enabled
        if (this.options.enableOAuth) {
          if (!this.options.oauthConfig) {
            throw new Error("OAuth is enabled but OAuth config is missing.");
          }
          const env = this.options.oauthConfig;
          const proxyProvider = new ProxyOAuthServerProvider({
            endpoints: {
              authorizationUrl: env.OAUTH_AUTHORIZATION_URL,
              tokenUrl: env.OAUTH_TOKEN_URL,
              revocationUrl: env.OAUTH_REVOCATION_URL,
            },
            verifyAccessToken: async (token) => ({
              token,
              clientId: env.OAUTH_CLIENT_ID,
              scopes: env.OAUTH_SCOPES,
            }),
            getClient: async (client_id) => ({
              client_id,
              redirect_uris: [env.OAUTH_REDIRECT_URI],
            }),
          });

          const oauthRouter = mcpAuthRouter({
            provider: proxyProvider,
            issuerUrl: new URL(env.OAUTH_ISSUER_URL),
            baseUrl: new URL(env.OAUTH_BASE_URL),
            serviceDocumentationUrl: new URL(env.OAUTH_DOCS_URL),
          });

          await this.httpServer.registerOAuthRouter(oauthRouter);
        }
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

  public getHttpServer(): HttpServer | null {
    return this.httpServer;
  }
}
