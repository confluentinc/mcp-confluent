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
 *
 * Constructed via {@link OAuthHolder.start}, which returns synchronously and
 * runs PKCE in the background. The {@link bootstrapPromise} field always
 * resolves (never rejects) — callers inspect the holder's accessors after the
 * await to know whether bootstrap succeeded.
 */
export class OAuthHolder {
  private ctx: AuthContext | undefined;
  private cleared = false;
  readonly bootstrapPromise: Promise<void>;

  private constructor(env: Auth0Environment) {
    // Idiomatic async-init: `bootstrapPromise` is the documented completion
    // handle (see class JSDoc). Holder is fully usable immediately after
    // construction — every method correctly handles the bootstrapping state.
    this.bootstrapPromise = this.runBootstrap(env); // NOSONAR(S7059)
  }

  /**
   * Construct a holder synchronously and run PKCE login in the background.
   * Returned holder has undefined tokens until {@link bootstrapPromise}
   * settles. Shutdown is safe at any point.
   */
  static start(env: Auth0Environment): OAuthHolder {
    return new OAuthHolder(env);
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
    this.cleared = true;
  }

  private async runBootstrap(env: Auth0Environment): Promise<void> {
    const auth0Config = getAuth0Config(env);
    logger.info({ env }, "Starting OAuth login");
    try {
      const tokenChain = await runPkceLogin(auth0Config);
      // shutdown() may have fired during PKCE — discard the in-flight context.
      if (this.cleared) {
        logger.info(
          { env },
          "OAuth login completed but holder was cleared; discarding tokens",
        );
        return;
      }
      const tokens: ConfluentTokenSet = {
        ...tokenChain,
        accessToken: generateOpaqueToken(),
      };
      const ctx = AuthContext.fromTokens(auth0Config, tokens);
      ctx.startRefreshLoop(DEFAULT_REFRESH_INTERVAL_MS);
      this.ctx = ctx;
      logger.info({ env }, "OAuth login successful");
    } catch (err) {
      // If shutdown closed the PKCE HTTP server out from under us, downgrade
      // the user-facing log from "failed" to "discarded after shutdown".
      if (this.cleared) {
        logger.info(
          { env, err },
          "OAuth login failed after holder was cleared; discarding error",
        );
        return;
      }
      logger.error({ env, err }, "OAuth login failed");
    }
  }
}
