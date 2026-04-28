import { AuthContext } from "@src/confluent/oauth/auth-context.js";
import { getAuth0Config } from "@src/confluent/oauth/auth0-config.js";
import { generateOpaqueToken } from "@src/confluent/oauth/crypto-utils.js";
import { runPkceLogin } from "@src/confluent/oauth/pkce-login.js";
import { DEFAULT_REFRESH_INTERVAL_MS } from "@src/confluent/oauth/token-lifetimes.js";
import type {
  Auth0Environment,
  ConfluentTokenSet,
} from "@src/confluent/oauth/types.js";
import { logger } from "@src/logger.js";

/**
 * Owns the current {@link AuthContext} reference for the process. Builds the
 * first context from a PKCE login and exposes the read-side accessors that
 * the bearer middleware uses.
 */
export class AuthHolder {
  private ctx: AuthContext | undefined;

  private constructor(initialContext: AuthContext | undefined) {
    this.ctx = initialContext;
  }

  /**
   * Run PKCE login interactively, build the first {@link AuthContext},
   * start its refresh loop, and return a holder wrapping it.
   */
  static async bootstrap(env: Auth0Environment): Promise<AuthHolder> {
    const auth0Config = getAuth0Config(env);
    logger.info({ env }, "Starting OAuth login");
    const tokenChain = await runPkceLogin(auth0Config);
    const tokens: ConfluentTokenSet = {
      ...tokenChain,
      accessToken: generateOpaqueToken(),
    };
    const ctx = AuthContext.fromTokens(auth0Config, tokens);
    ctx.startRefreshLoop(DEFAULT_REFRESH_INTERVAL_MS);
    logger.info({ env }, "OAuth login successful");
    return new AuthHolder(ctx);
  }

  /** Live control-plane bearer token; `undefined` while broken. */
  getControlPlaneToken(): string | undefined {
    return this.ctx?.getControlPlaneToken();
  }

  /** Live data-plane bearer token; `undefined` while broken. */
  getDataPlaneToken(): string | undefined {
    return this.ctx?.getDataPlaneToken();
  }

  /** Stops the refresh loop and clears the held context. Safe to double-call. */
  shutdown(): void {
    this.ctx?.clear();
    this.ctx = undefined;
  }
}
