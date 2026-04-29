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

type HolderState = "bootstrapping" | "ready" | "failed" | "cleared";

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
  private state: HolderState = "bootstrapping";
  readonly bootstrapPromise: Promise<void>;

  private constructor(
    initialContextOrEnv: AuthContext | undefined | { env: Auth0Environment },
  ) {
    if (
      initialContextOrEnv &&
      typeof initialContextOrEnv === "object" &&
      "env" in initialContextOrEnv
    ) {
      // start() path — kick off background bootstrap.
      this.bootstrapPromise = this.runBootstrap(initialContextOrEnv.env);
    } else {
      // Legacy bootstrap() path — context is already wired up.
      this.ctx = initialContextOrEnv as AuthContext | undefined;
      this.state = this.ctx ? "ready" : "cleared";
      this.bootstrapPromise = Promise.resolve();
    }
  }

  /**
   * Construct a holder synchronously and run PKCE login in the background.
   * Returned holder is in `"bootstrapping"` state with undefined tokens until
   * {@link bootstrapPromise} settles. Shutdown is safe at any point.
   */
  static start(env: Auth0Environment): OAuthHolder {
    return new OAuthHolder({ env });
  }

  /**
   * Run PKCE login interactively, build the first {@link AuthContext},
   * start its refresh loop, and return a holder wrapping it.
   *
   * @deprecated Use {@link OAuthHolder.start} for non-blocking bootstrap. This
   * factory is retained only for the interim until call sites migrate; it
   * will be removed in the same PR.
   */
  static async bootstrap(env: Auth0Environment): Promise<OAuthHolder> {
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
    return new OAuthHolder(ctx);
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
    this.state = "cleared";
  }

  private async runBootstrap(env: Auth0Environment): Promise<void> {
    const auth0Config = getAuth0Config(env);
    logger.info({ env }, "Starting OAuth login");
    try {
      const tokenChain = await runPkceLogin(auth0Config);
      // shutdown() may have fired during PKCE — discard the in-flight context.
      if (this.state === "cleared") {
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
      this.state = "ready";
      logger.info({ env }, "OAuth login successful");
    } catch (err) {
      // Cleared mid-bootstrap — keep state="cleared", just log and return.
      if (this.state === "cleared") {
        logger.info(
          { env, err },
          "OAuth login failed after holder was cleared; discarding error",
        );
        return;
      }
      this.state = "failed";
      logger.error({ env, err }, "OAuth login failed");
    }
  }
}
