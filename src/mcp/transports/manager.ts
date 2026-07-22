import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "@src/logger.js";
import type { CreateMcpServerOptions } from "@src/mcp/server.js";
import { createMcpServer } from "@src/mcp/server.js";
import type { AuthConfig } from "@src/mcp/transports/auth.js";
import { HttpTransport } from "@src/mcp/transports/http.js";
import { HttpServer } from "@src/mcp/transports/server.js";
import { SseTransport } from "@src/mcp/transports/sse.js";
import { StdioTransport } from "@src/mcp/transports/stdio.js";
import type { Transport } from "@src/mcp/transports/types.js";
import { TransportType } from "@src/mcp/transports/types.js";

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

  constructor(private readonly config?: TransportManagerConfig) {}

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
        await this.httpServer.prepare(http);

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
        await this.httpServer.start(http);
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

    // close the cached stdio McpServer; HTTP and SSE per-session servers were already closed
    // by their respective transports' disconnect() above
    if (this.stdioServer) {
      await this.stdioServer.close();
      this.stdioServer = null;
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
          () => createMcpServer(serverOptions),
          this.httpServer,
          http?.sseEndpointPath,
          http?.sseMessageEndpointPath,
        );
      case TransportType.STDIO:
        // stdio is single-client by construction (one process, one stdin/stdout pair), so we
        // cache one McpServer for the lifetime of the manager rather than minting per session
        return new StdioTransport(
          (this.stdioServer ??= createMcpServer(serverOptions)),
        );
      default:
        throw new Error(`Unsupported transport type: ${type}`);
    }
  }
}
