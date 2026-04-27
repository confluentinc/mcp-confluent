import { AuthContext } from "@src/confluent/oauth/auth-context.js";
import { getAuth0Config } from "@src/confluent/oauth/auth0-config.js";
import { generateOpaqueToken } from "@src/confluent/oauth/crypto-utils.js";
import { hasNonTransientError } from "@src/confluent/oauth/errors.js";
import {
  PkceLoginError,
  runPkceLogin,
} from "@src/confluent/oauth/pkce-login.js";
import { DEFAULT_REFRESH_INTERVAL_MS } from "@src/confluent/oauth/token-lifetimes.js";
import type {
  Auth0Config,
  Auth0Environment,
  ConfluentTokenSet,
} from "@src/confluent/oauth/types.js";
import { logger } from "@src/logger.js";

/**
 * Wrapper that owns the current {@link AuthContext} reference for the
 * process. Exposes the read-side accessors that the bearer middleware
 * uses (PR 2) and a single-flight `recoverIfBroken` (used by middleware
 * when the held context's refresh chain enters a non-transient state).
 */
export class AuthHolder {
  private ctx: AuthContext | undefined;
  private inflightRecover: Promise<void> | null = null;

  private constructor(
    private readonly auth0Config: Auth0Config,
    initialContext: AuthContext | undefined,
  ) {
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
    const ctx = AuthContext.fromTokensForHolder(auth0Config, tokens);
    ctx.startRefreshLoop(DEFAULT_REFRESH_INTERVAL_MS);
    logger.info({ env }, "OAuth login successful");
    return new AuthHolder(auth0Config, ctx);
  }

  /** Live control-plane bearer token; `undefined` while broken. */
  getControlPlaneToken(): string | undefined {
    return this.ctx?.getControlPlaneToken();
  }

  /** Live data-plane bearer token; `undefined` while broken. */
  getDataPlaneToken(): string | undefined {
    return this.ctx?.getDataPlaneToken();
  }

  /** True iff the held context has a non-transient refresh error recorded. */
  hasNonTransientError(): boolean {
    if (!this.ctx) return false;
    return hasNonTransientError(this.ctx.getErrors());
  }

  /**
   * Single-flight. If tokens are still good, returns immediately. Otherwise
   * runs PKCE again, builds a fresh context, swaps it in, restarts the
   * refresh loop, and clears the old context. Concurrent callers share one
   * in-flight recovery.
   */
  async recoverIfBroken(): Promise<void> {
    // CP-only health check is sufficient as long as DP TTL >= CP TTL (the
    // current `token-lifetimes.ts` invariant: DP=10min, CP=5min). If those
    // ever invert, expand this to also check `getDataPlaneToken()`.
    if (
      this.ctx?.getControlPlaneToken() !== undefined &&
      !this.hasNonTransientError()
    ) {
      return;
    }
    if (this.inflightRecover) return this.inflightRecover;
    this.inflightRecover = this.doRecover();
    try {
      await this.inflightRecover;
    } finally {
      this.inflightRecover = null;
    }
  }

  private async doRecover(): Promise<void> {
    logger.warn("OAuth recovery starting (re-running PKCE login)");
    let tokenChain;
    try {
      tokenChain = await runPkceLogin(this.auth0Config);
    } catch (err) {
      logger.error({ err }, "OAuth recovery failed");
      throw err instanceof PkceLoginError
        ? err
        : new PkceLoginError(
            "auth0_unreachable",
            err instanceof Error ? err.message : String(err),
          );
    }
    const newCtx = AuthContext.fromTokensForHolder(this.auth0Config, {
      ...tokenChain,
      accessToken: generateOpaqueToken(),
    });
    newCtx.startRefreshLoop(DEFAULT_REFRESH_INTERVAL_MS);
    const old = this.ctx;
    this.ctx = newCtx;
    old?.clear();
    logger.info("OAuth recovery succeeded; new context installed");
  }

  /**
   * Wait briefly for an in-flight refresh on the held context to complete.
   * Used by the bearer middleware to tolerate the 5-min CP rotation window
   * without triggering a recovery.
   *
   * Returns once the current context is no longer mid-refresh, or after
   * `maxMs` regardless. Production middleware calls this with `maxMs <= 5s`.
   */
  async waitForRefresh(opts: { maxMs: number }): Promise<void> {
    if (!this.ctx) return;
    const inflight = (
      this.ctx as unknown as { inflightRefresh: Promise<void> | null }
    ).inflightRefresh;
    if (!inflight) return;
    await Promise.race([
      inflight,
      new Promise<void>((resolve) => setTimeout(resolve, opts.maxMs)),
    ]);
  }

  /** Stops the refresh loop and clears the held context. Safe to double-call. */
  shutdown(): void {
    this.ctx?.clear();
    this.ctx = undefined;
  }
}
