import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "@src/logger.js";
import { createMcpServer, CreateMcpServerOptions } from "@src/mcp/server.js";
import { AuthConfig } from "@src/mcp/transports/auth.js";
import { HttpTransport } from "@src/mcp/transports/http.js";
import { HttpServer } from "@src/mcp/transports/server.js";
import { SseTransport } from "@src/mcp/transports/sse.js";
import { StdioTransport } from "@src/mcp/transports/stdio.js";
import { Transport, TransportType } from "@src/mcp/transports/types.js";

/**
 * Configuration for the transport manager
 */
export interface TransportManagerConfig {
  /** Disable authentication for HTTP/SSE transports */
  readonly disableAuth?: boolean;
  /** List of allowed Host header values for DNS rebinding protection */
  readonly allowedHosts?: readonly string[];
  /** API key for authentication (required when auth is enabled) */
  readonly apiKey?: string;
}

/** HTTP/SSE bind config; ignored for stdio-only setups. */
export interface HttpStartOptions {
  readonly port: number;
  readonly host: string;
  readonly mcpEndpointPath?: string;
  readonly sseEndpointPath?: string;
  readonly sseMessageEndpointPath?: string;
}

export interface TransportStartOptions {
  readonly serverOptions: CreateMcpServerOptions;
  readonly types: readonly TransportType[];
  /** Required when {@linkcode types} includes HTTP or SSE. */
  readonly http?: HttpStartOptions;
}

export class TransportManager {
  private readonly transports: Map<TransportType, Transport> = new Map();
  private httpServer: HttpServer | null = null;
  private stdioServer: McpServer | null = null;
  private sseServer: McpServer | null = null;

  constructor(private readonly config?: TransportManagerConfig) {}

  /**
   * Returns the cached {@link McpServer} for {@linkcode transport}, creating it lazily on first
   * call. Only stdio/SSE are cached; HTTP creates a fresh server per session inside the transport.
   *
   * @internal Production callers go through {@linkcode TransportManager.start}; exposed so unit
   *   tests can assert the per-transport invariant directly.
   */
  getServer(
    transport: TransportType.STDIO | TransportType.SSE,
    serverOptions: CreateMcpServerOptions,
  ): McpServer {
    switch (transport) {
      case TransportType.STDIO:
        return (this.stdioServer ??= createMcpServer(serverOptions));
      case TransportType.SSE:
        return (this.sseServer ??= createMcpServer(serverOptions));
    }
  }

  async start(options: TransportStartOptions): Promise<void> {
    const { serverOptions, types, http } = options;
    try {
      const needsHttpServer = types.some(
        (type) => type === TransportType.HTTP || type === TransportType.SSE,
      );

      // Initialize and prepare HTTP server if needed
      if (needsHttpServer) {
        if (!http) {
          throw new Error(
            "HTTP/SSE transports require `http` start options (port, host)",
          );
        }
        // Prepare auth configuration
        const authEnabled = !this.config?.disableAuth;
        const apiKey = this.config?.apiKey;

        // Require API key when auth is enabled
        if (authEnabled && !apiKey) {
          throw new Error(
            "MCP_API_KEY is required when authentication is enabled for HTTP/SSE transports. " +
              "Generate a key using: npx mcp-confluent --generate-key",
          );
        }

        const authConfig: AuthConfig = {
          apiKey: apiKey || "",
          enabled: authEnabled,
          allowedHosts: this.config?.allowedHosts || ["localhost", "127.0.0.1"],
        };

        this.httpServer = new HttpServer({ auth: authConfig });
        await this.httpServer.prepare();

        if (authEnabled) {
          logger.info("MCP Server authentication enabled");
        }
      }

      // Create and connect all transports
      await Promise.all(
        types.map(async (type) => {
          const transport = this.createTransport(type, serverOptions, http);
          this.transports.set(type, transport);
          await transport.connect();
        }),
      );

      // Start HTTP server if needed (after routes are registered)
      if (needsHttpServer && this.httpServer && http) {
        await this.httpServer.start({ port: http.port, host: http.host });
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

    // close cached stdio/SSE McpServers; HTTP per-session ones were closed by HttpTransport above
    if (this.stdioServer) {
      await this.stdioServer.close();
      this.stdioServer = null;
    }
    if (this.sseServer) {
      await this.sseServer.close();
      this.sseServer = null;
    }
  }

  private createTransport(
    type: TransportType,
    serverOptions: CreateMcpServerOptions,
    http: HttpStartOptions | undefined,
  ): Transport {
    switch (type) {
      case TransportType.HTTP:
        if (!this.httpServer) {
          throw new Error("HTTP server not initialized");
        }
        return new HttpTransport(
          () => createMcpServer(serverOptions),
          this.httpServer,
          http?.mcpEndpointPath,
        );
      case TransportType.SSE:
        if (!this.httpServer) {
          throw new Error("HTTP server not initialized");
        }
        return new SseTransport(
          this.getServer(TransportType.SSE, serverOptions),
          this.httpServer,
          http?.sseEndpointPath,
          http?.sseMessageEndpointPath,
        );
      case TransportType.STDIO:
        return new StdioTransport(
          this.getServer(TransportType.STDIO, serverOptions),
        );
      default:
        throw new Error(`Unsupported transport type: ${type}`);
    }
  }
}
