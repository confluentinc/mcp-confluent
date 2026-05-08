import { AuthContext } from "@src/confluent/oauth/auth-context.js";
import { getAuth0Config } from "@src/confluent/oauth/auth0-config.js";
import { generateOpaqueToken } from "@src/confluent/oauth/crypto-utils.js";
import { hasNonTransientError } from "@src/confluent/oauth/errors.js";
import {
  PkceLoginError,
  runPkceLogin,
} from "@src/confluent/oauth/pkce-login.js";
import type { TokenChainResult } from "@src/confluent/oauth/token-chain.js";
import type {
  Auth0Environment,
  ConfluentTokenSet,
} from "@src/confluent/oauth/types.js";
import { logger } from "@src/logger.js";

/**
 * Owns the process's {@link AuthContext} and lazily drives PKCE on demand.
 * Construction is side-effect-free; callers go through {@link ensureLoggedIn}.
 *
 * State machine:
 *   - Idle: starts PKCE.
 *   - Logging in: concurrent callers share the in-flight Promise.
 *   - Logged in: no-op (or single-flight refresh if bearer tokens are stale).
 *   - Failed / refresh-family expired: clears ctx and starts a fresh PKCE.
 *   - Shut down: rejects.
 */
export class OAuthHolder {
  private ctx: AuthContext | undefined;
  private cleared = false;
  private readonly abortController = new AbortController();
  private inFlightLogin: Promise<void> | null = null;

  constructor(private readonly env: Auth0Environment) {}

  getControlPlaneToken(): string | undefined {
    return this.ctx?.getControlPlaneToken();
  }

  getDataPlaneToken(): string | undefined {
    return this.ctx?.getDataPlaneToken();
  }

  /**
   * Ensure the holder has usable bearer tokens, starting PKCE on demand.
   * Single-flight, replayable after a PKCE failure, rejects after shutdown.
   */
  async ensureLoggedIn(): Promise<void> {
    if (this.cleared) {
      throw new Error("OAuthHolder is shut down");
    }
    if (this.inFlightLogin) {
      return this.inFlightLogin;
    }
    if (this.ctx) {
      if (
        this.ctx.refreshTokenExpired() ||
        hasNonTransientError(this.ctx.getErrors())
      ) {
        this.ctx.clear();
        this.ctx = undefined;
        // fall through to PKCE
      } else if (
        this.ctx.getControlPlaneToken() !== undefined &&
        this.ctx.getDataPlaneToken() !== undefined
      ) {
        return;
      } else {
        // Refresh token alive but bearer tokens stale (e.g., system sleep
        // suspended the refresh-loop tick). Refresh on demand rather than
        // re-prompt; `AuthContext.refresh()` joins any in-flight refresh.
        await this.ctx.refresh();
        if (this.cleared) {
          throw new Error("OAuthHolder is shut down");
        }
        if (
          this.ctx.getControlPlaneToken() !== undefined &&
          this.ctx.getDataPlaneToken() !== undefined
        ) {
          return;
        }
        // Refresh didn't restore tokens. Surface a retry-friendly error
        // rather than launch a browser; if the failure becomes
        // non-transient, the next call falls through to PKCE.
        throw new Error(
          "OAuth bearer tokens unavailable after refresh; retry the tool call",
        );
      }
    }
    this.inFlightLogin = this.runLogin().finally(() => {
      this.inFlightLogin = null;
    });
    return this.inFlightLogin;
  }

  /**
   * Terminal — clears ctx (which stops the refresh loop) and aborts any
   * in-flight PKCE. Idempotent.
   */
  shutdown(): void {
    this.ctx?.clear();
    this.ctx = undefined;
    this.cleared = true;
    this.abortController.abort();
  }

  private async runLogin(): Promise<void> {
    const auth0Config = getAuth0Config(this.env);
    logger.info({ env: this.env }, "Starting OAuth login");
    let tokenChain: TokenChainResult;
    try {
      tokenChain = await runPkceLogin(auth0Config, this.abortController.signal);
    } catch (err) {
      // The MCP tool-call wrapper rethrows but doesn't log; surface the
      // failure here so server stderr captures the cause (timeout,
      // port_in_use, configuration, user_aborted).
      if (this.cleared) {
        logger.info({ env: this.env }, "OAuth login aborted by shutdown");
      } else {
        const reason = err instanceof PkceLoginError ? err.reason : undefined;
        logger.error({ env: this.env, err, reason }, "OAuth login failed");
      }
      throw err;
    }
    if (this.cleared) {
      // shutdown() raced with PKCE completion — discard the tokens we just
      // obtained rather than attaching them to a holder that's been
      // explicitly torn down.
      logger.info(
        { env: this.env },
        "OAuth login completed but holder was cleared; discarding tokens",
      );
      return;
    }
    const tokens: ConfluentTokenSet = {
      ...tokenChain,
      accessToken: generateOpaqueToken(),
    };
    const ctx = AuthContext.fromTokens(auth0Config, tokens);
    ctx.startRefreshLoop();
    this.ctx = ctx;
    logger.info({ env: this.env }, "OAuth login successful");
  }
}
