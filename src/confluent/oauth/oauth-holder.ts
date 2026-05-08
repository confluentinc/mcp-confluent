import { AuthContext } from "@src/confluent/oauth/auth-context.js";
import { getAuth0Config } from "@src/confluent/oauth/auth0-config.js";
import { generateOpaqueToken } from "@src/confluent/oauth/crypto-utils.js";
import { hasNonTransientError } from "@src/confluent/oauth/errors.js";
import { runPkceLogin } from "@src/confluent/oauth/pkce-login.js";
import type {
  Auth0Environment,
  ConfluentTokenSet,
} from "@src/confluent/oauth/types.js";
import { logger } from "@src/logger.js";

/**
 * Owns the current {@link AuthContext} reference for the process and gates
 * when PKCE login runs. Construction is side-effect-free; callers drive the
 * lifecycle through {@link ensureLoggedIn}, which the MCP tool-call wrapper
 * invokes lazily before any handler that needs Confluent access.
 *
 * State machine:
 *   - Idle (no ctx, no in-flight login): `ensureLoggedIn()` starts PKCE.
 *   - Logging in: concurrent callers share the cached Promise.
 *   - Logged in (ctx usable): `ensureLoggedIn()` is a no-op.
 *   - Failed / expired (ctx unusable): `ensureLoggedIn()` clears the dead
 *     ctx, transitions back to Idle, and starts a fresh PKCE.
 *   - Shut down: `ensureLoggedIn()` rejects.
 */
export class OAuthHolder {
  private ctx: AuthContext | undefined;
  private cleared = false;
  private readonly abortController = new AbortController();
  private inFlightLogin: Promise<void> | null = null;

  constructor(private readonly env: Auth0Environment) {}

  /** Live control-plane bearer token; `undefined` until `ensureLoggedIn()` resolves. */
  getControlPlaneToken(): string | undefined {
    return this.ctx?.getControlPlaneToken();
  }

  /** Live data-plane bearer token; `undefined` until `ensureLoggedIn()` resolves. */
  getDataPlaneToken(): string | undefined {
    return this.ctx?.getDataPlaneToken();
  }

  /**
   * Ensure the holder has a usable {@link AuthContext}, starting PKCE on
   * demand. Single-flight: concurrent calls share the same in-flight login.
   * Replayable: rejects when PKCE fails, but the next call starts a fresh
   * attempt rather than locking the holder permanently. Rejects after
   * {@link shutdown}.
   *
   * The PKCE failure path resets `inFlightLogin` to `null` (via `.finally`)
   * so a subsequent caller observes Idle state and can retry. The
   * AbortController is shared across attempts; once `shutdown()` aborts it,
   * the holder is permanently terminal.
   */
  async ensureLoggedIn(): Promise<void> {
    if (this.cleared) {
      throw new Error("OAuthHolder is shut down");
    }
    if (this.inFlightLogin) {
      return this.inFlightLogin;
    }
    if (this.ctx) {
      // Usable contexts are a no-op fast path. Unusable contexts (refresh
      // family expired, non-transient error recorded) are cleared so the
      // next steps start from a clean Idle state. Atomically clearing here
      // — before the await on `runLogin()` — ensures concurrent callers
      // don't race into two parallel PKCE flows after a state transition.
      if (
        !this.ctx.refreshTokenExpired() &&
        !hasNonTransientError(this.ctx.getErrors())
      ) {
        return;
      }
      this.ctx.clear();
      this.ctx = undefined;
    }
    this.inFlightLogin = this.runLogin().finally(() => {
      this.inFlightLogin = null;
    });
    return this.inFlightLogin;
  }

  /**
   * Stops the refresh loop, clears the held context, and aborts any
   * in-flight PKCE login. Idempotent. Once shut down, `ensureLoggedIn()`
   * rejects — the holder is terminal.
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
    const tokenChain = await runPkceLogin(
      auth0Config,
      this.abortController.signal,
    );
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
