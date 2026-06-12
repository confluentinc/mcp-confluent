import {
  type OAuthConnectionConfig,
  MCPServerConfiguration,
} from "@src/config/index.js";
import { BaseClientManager } from "@src/confluent/base-client-manager.js";
import { constructDirectClientManager } from "@src/confluent/direct-client-manager.js";
import { OAuthClientManager } from "@src/confluent/oauth-client-manager.js";
import { OAuthHolder } from "@src/confluent/oauth/oauth-holder.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";

/**
 * Aggregate of all runtime state threaded through the server.
 *
 * Carries config and per-connection client managers.
 */
export class ServerRuntime {
  readonly config: MCPServerConfiguration;
  readonly clientManagers: Record<string, BaseClientManager>;
  /**
   * The active OAuth holder when any connection in the config has `type === "oauth"`.
   * Constructed by {@link ServerRuntime.fromConfig}; `undefined` on api_key paths.
   * Construction is side-effect-free — PKCE runs lazily on the first
   * `holder.ensureLoggedIn()` call, which the MCP tool-call wrapper invokes
   * before any handler that needs Confluent access.
   */
  readonly oauthHolder: OAuthHolder | undefined;

  /**
   * Tool names the operator's allow/block-list left enabled, or `undefined`
   * when no list was configured (all tools allowed — cli.ts's default-on
   * behavior). The `undefined`-means-unfiltered sentinel is this class's own
   * business: callers ask {@link isToolAllowed} rather than branching on it.
   */
  private readonly allowedToolNames: ReadonlySet<ToolName> | undefined;

  constructor(
    config: MCPServerConfiguration,
    clientManagers: Record<string, BaseClientManager>,
    oauthHolder: OAuthHolder | undefined = undefined,
    allowedToolNames: ReadonlySet<ToolName> | undefined = undefined,
  ) {
    this.config = config;
    this.clientManagers = clientManagers;
    this.oauthHolder = oauthHolder;
    this.allowedToolNames = allowedToolNames;
  }

  /**
   * Whether the operator's allow/block-list leaves `name` invokable. Always
   * `true` when no list was configured. The single source of truth for the
   * operator filter, shared by tool registration and the `list-configured-connections`
   * tool so the advertised set and the reported set can never diverge.
   */
  isToolAllowed(name: ToolName): boolean {
    return (
      this.allowedToolNames === undefined || this.allowedToolNames.has(name)
    );
  }

  /**
   * Single-connection scaffolding: returns the sole client manager, throwing
   * when zero or more than one connection is configured. Has no remaining
   * callers; deletion tracked in #554.
   */
  get clientManager(): BaseClientManager {
    const managers = Object.values(this.clientManagers);
    if (managers.length === 0) {
      throw new Error("ServerRuntime has no client managers");
    }
    if (managers.length > 1) {
      // This getter is the single-connection scaffolding; a config with more
      // than one connection has no "sole" manager. Callers route by id via
      // clientManagers[id]. Deletion of this getter tracked in #554.
      throw new Error(
        "ServerRuntime has multiple client managers; use clientManagers[id] directly",
      );
    }
    return managers[0]!;
  }

  /**
   * Disconnect every per-connection client manager. The teardown counterpart
   * to the per-connection construction in {@link fromConfig}; a multi-connection
   * config tears all of its connections down, where the single-connection
   * {@link clientManager} getter could only reach one.
   */
  async disconnectAll(): Promise<void> {
    await Promise.all(
      Object.values(this.clientManagers).map((manager) => manager.disconnect()),
    );
  }

  static fromConfig(
    config: MCPServerConfiguration,
    allowedToolNames: ReadonlySet<ToolName> | undefined = undefined,
  ): ServerRuntime {
    const oauthConns = Object.values(config.connections).filter(
      (c): c is OAuthConnectionConfig => c.type === "oauth",
    );
    if (oauthConns.length > 1) {
      // Only one OAuth connection is supported (the shared OAuthHolder owns a
      // single CCloud identity). Reject multi-OAuth explicitly rather than
      // silently picking one.
      throw new Error(
        `Multiple OAuth connections defined in configuration; only one is supported`,
      );
    }
    const oauthConn = oauthConns[0];
    const oauthHolder = oauthConn
      ? new OAuthHolder(oauthConn.ccloud_env)
      : undefined;

    // Construct a client manager per connection, keyed on the connection's own
    // type — a direct connection always gets a DirectClientManager even when a
    // sibling OAuth connection exists, so the epic's "OAuth Confluent Cloud +
    // local Apache Kafka broker side by side" config wires each connection to a
    // manager that can actually reach it.
    const clientManagers = Object.fromEntries(
      Object.entries(config.connections).map(([id, conn]) => {
        if (conn.type === "oauth") {
          if (!oauthHolder) {
            throw new Error(
              `Wacky -- connection ${id} is oauth but no OAuthHolder was constructed`,
            );
          }
          return [
            id,
            new OAuthClientManager(
              oauthHolder,
              conn.ccloud_env,
              conn.kafka_debug,
            ),
          ] as const;
        }
        return [id, constructDirectClientManager(conn)] as const;
      }),
    );
    return new ServerRuntime(
      config,
      clientManagers,
      oauthHolder,
      allowedToolNames,
    );
  }
}
