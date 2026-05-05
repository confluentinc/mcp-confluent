import {
  type OAuthConnectionConfig,
  MCPServerConfiguration,
} from "@src/config/index.js";
import { BaseClientManager } from "@src/confluent/base-client-manager.js";
import {
  constructDirectClientManager,
  DirectClientManager,
} from "@src/confluent/direct-client-manager.js";
import { OAuthClientManager } from "@src/confluent/oauth-client-manager.js";
import { OAuthHolder } from "@src/confluent/oauth/oauth-holder.js";

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
   * The holder runs PKCE in the background — callers can await
   * `holder.bootstrapPromise` to know the bootstrap attempt has finished, then
   * inspect the token accessors to determine whether tokens are available.
   */
  readonly oauthHolder: OAuthHolder | undefined;

  constructor(
    config: MCPServerConfiguration,
    clientManagers: Record<string, BaseClientManager>,
    oauthHolder: OAuthHolder | undefined = undefined,
  ) {
    this.config = config;
    this.clientManagers = clientManagers;
    this.oauthHolder = oauthHolder;
  }

  /**
   * Convenience accessor for the single-connection period.
   * Remove (or make multi-connection-aware) when issue #151 lands.
   */
  get clientManager(): BaseClientManager {
    const managers = Object.values(this.clientManagers);
    if (managers.length === 0) {
      throw new Error("ServerRuntime has no client managers");
    }
    if (managers.length > 1) {
      // enforceSingleConnectionOnly() in config/models.ts should prevent this at parse time;
      // this guard is the runtime mirror of that constraint.
      throw new Error(
        "ServerRuntime has multiple client managers; use clientManagers[id] directly",
      );
    }
    return managers[0]!;
  }

  /**
   * Narrows the sole client manager to a {@link DirectClientManager} or throws
   * if the connection is OAuth-backed. Native-Kafka tools call this instead of
   * {@link clientManager} so a missing-on-OAuth Kafka method is a compile-time
   * error rather than a runtime throw on a stub. Their `hasKafka` predicates
   * already gate them off for OAuth connections, so the throw here is defensive.
   */
  requireDirectClientManager(): DirectClientManager {
    const cm = this.clientManager;
    if (!(cm instanceof DirectClientManager)) {
      throw new Error(
        "Native Kafka tools require a direct (non-OAuth) connection.",
      );
    }
    return cm;
  }

  static fromConfig(config: MCPServerConfiguration): ServerRuntime {
    const oauthConns = Object.values(config.connections).filter(
      (c): c is OAuthConnectionConfig => c.type === "oauth",
    );
    if (oauthConns.length > 1) {
      // `enforceSingleConnectionOnly()` already prevents this today; keep the
      // defensive check so that when multi-connection support lands (#151),
      // multi-OAuth is rejected explicitly rather than silently picking one.
      throw new Error(
        `Multiple OAuth connections defined in configuration; only one is supported`,
      );
    }
    const oauthConn = oauthConns[0];
    const oauthHolder = oauthConn
      ? OAuthHolder.start(oauthConn.ccloud_env)
      : undefined;

    // Construct a client manager for each connection in the config.
    // (although currently there will only be one, see `enforceSingleConnectionOnly()`)
    // When OAuth is in play, every connection's manager is bearer-auth-backed by
    // the shared holder; otherwise, fall back to the per-connection direct factory.
    const clientManagers = Object.fromEntries(
      Object.entries(config.connections).map(([id, conn]) => {
        if (oauthHolder && oauthConn) {
          return [
            id,
            new OAuthClientManager(oauthHolder, oauthConn.ccloud_env),
          ] as const;
        }
        // No OAuth connection found, so every connection is direct.
        if (conn.type !== "direct") {
          throw new Error(
            `Internal error: connection ${id} is not direct but no OAuth holder was constructed`,
          );
        }
        return [id, constructDirectClientManager(conn)] as const;
      }),
    );
    return new ServerRuntime(config, clientManagers, oauthHolder);
  }
}
