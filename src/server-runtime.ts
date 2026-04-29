import { MCPServerConfiguration } from "@src/config/index.js";
import {
  constructClientManagerForConnection,
  type ClientManager,
} from "@src/confluent/client-manager.js";
import { OAuthHolder } from "@src/confluent/oauth/oauth-holder.js";
import type { Environment } from "@src/env.js";

/**
 * Aggregate of all runtime state threaded through the server.
 *
 * Carries config, per-connection client managers, and (temporarily) the validated
 * Environment. The `env` field is a shim for the issue-173 migration timeline:
 * it is read by `getToolHandlersToRegister()` and the `enabledConnectionIds()` shim
 * in `BaseToolHandler` to check `getRequiredEnvVars()`. Once that migration is
 * complete and `getRequiredEnvVars()` is deleted, remove `env` from this class.
 */
export class ServerRuntime {
  readonly config: MCPServerConfiguration;
  readonly clientManagers: Record<string, ClientManager>;
  /** @deprecated Shim field — remove after issue-173 cutover. */
  readonly env: Environment;
  /**
   * The active OAuth holder when the config carries a CCloud OAuth connection.
   * Constructed by {@link ServerRuntime.fromConfig} when `config.getCCloudOAuth()`
   * returns a value; `undefined` on api_key paths. The holder runs PKCE in the
   * background — callers can await `holder.bootstrapPromise` to know the
   * bootstrap attempt has finished, then inspect the token accessors to
   * determine whether tokens are available.
   */
  readonly oauthHolder: OAuthHolder | undefined;

  constructor(
    config: MCPServerConfiguration,
    clientManagers: Record<string, ClientManager>,
    env: Environment,
    oauthHolder: OAuthHolder | undefined = undefined,
  ) {
    this.config = config;
    this.clientManagers = clientManagers;
    this.env = env;
    this.oauthHolder = oauthHolder;
  }

  /**
   * Convenience accessor for the single-connection period.
   * Remove (or make multi-connection-aware) when issue #151 lands.
   */
  get clientManager(): ClientManager {
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

  static fromConfig(
    config: MCPServerConfiguration,
    env: Environment,
  ): ServerRuntime {
    const ccloudOAuth = config.getCCloudOAuth();
    const oauthHolder = ccloudOAuth
      ? OAuthHolder.start(ccloudOAuth.env)
      : undefined;

    // Construct a ClientManager for each connection in the config.
    // (although currently there will only be one, see `enforceSingleConnectionOnly()`)
    const clientManagers = Object.fromEntries(
      Object.entries(config.connections).map(([id, conn]) => [
        id,
        constructClientManagerForConnection(conn),
      ]),
    );
    return new ServerRuntime(config, clientManagers, env, oauthHolder);
  }
}
