import { generateOpaqueToken } from "@src/confluent/oauth/crypto-utils.js";
import {
  exchangeControlPlaneForDataPlaneToken,
  exchangeIdTokenForControlPlaneToken,
  exchangeRefreshTokenForAuth0Tokens,
  executeFullTokenChain,
} from "@src/confluent/oauth/token-chain.js";
import {
  CONTROL_PLANE_REFRESH_WINDOW_MS,
  CONTROL_PLANE_TOKEN_LIFETIME_MS,
  DATA_PLANE_TOKEN_LIFETIME_MS,
  DEFAULT_REFRESH_INTERVAL_MS,
  REFRESH_TOKEN_IDLE_LIFETIME_MS,
} from "@src/confluent/oauth/token-lifetimes.js";
import type {
  Auth0Config,
  Auth0TokenResponse,
  ConfluentTokenSet,
} from "@src/confluent/oauth/types.js";
import { logger } from "@src/logger.js";

/**
 * Owns one user's Confluent OAuth lifecycle — token state plus the
 * transformations that advance it. Internal state advances via atomic
 * transform functions under {@link AuthContext.updateTokens} so each step is
 * atomic and no caller mutates the token set directly.
 */
export class AuthContext {
  private internalTokens: ConfluentTokenSet;
  private cleared = false;
  private refreshInterval: ReturnType<typeof setInterval> | null = null;
  private inflightRefresh: Promise<void> | null = null;

  private constructor(
    private readonly auth0Config: Auth0Config,
    tokens: ConfluentTokenSet,
  ) {
    this.internalTokens = tokens;
  }

  /** Runs the auth code → CP → DP chain and wraps the result in a context. */
  static async newFromInitialLogin(
    auth0Config: Auth0Config,
    authCode: string,
    codeVerifier: string,
  ): Promise<AuthContext> {
    const result = await executeFullTokenChain(
      auth0Config,
      authCode,
      codeVerifier,
    );
    return new AuthContext(auth0Config, {
      ...result,
      accessToken: generateOpaqueToken(),
    });
  }

  /** Opaque access token — stable across refreshes. */
  get accessToken(): string {
    return this.internalTokens.accessToken;
  }

  /**
   * Current control-plane bearer token, or `undefined` if the context is
   * cleared or the CP token has expired. Call this immediately before each
   * API request — don't cache the returned string across awaits.
   */
  getControlPlaneToken(): string | undefined {
    if (this.cleared) return undefined;
    if (this.internalTokens.controlPlaneExpiresAt <= Date.now())
      return undefined;
    return this.internalTokens.controlPlaneToken;
  }

  /**
   * Current data-plane bearer token, or `undefined` if the context is
   * cleared or the DP token has expired. Same usage guidance as
   * {@link getControlPlaneToken}.
   */
  getDataPlaneToken(): string | undefined {
    if (this.cleared) return undefined;
    if (this.internalTokens.dataPlaneExpiresAt <= Date.now()) return undefined;
    return this.internalTokens.dataPlaneToken;
  }

  /** True when the refresh token is no longer usable (expired or cleared). */
  refreshTokenExpired(now: number = Date.now()): boolean {
    if (this.cleared) return true;
    return (
      now >= this.internalTokens.refreshTokenAbsoluteExpiresAt ||
      now >= this.internalTokens.refreshTokenIdleExpiresAt
    );
  }

  /**
   * Pure predicate: should the refresh loop call `refresh()` on this context
   * right now? True when the refresh token is still live and the CP token is
   * within the refresh window.
   */
  shouldAttemptRefresh(now: number = Date.now()): boolean {
    if (this.refreshTokenExpired(now)) return false;
    return (
      this.internalTokens.controlPlaneExpiresAt - now <=
      CONTROL_PLANE_REFRESH_WINDOW_MS
    );
  }

  /**
   * Rotate the refresh token, then derive new CP and DP tokens. The rotated
   * refresh token is persisted before the CP/DP leg so a phase-2 failure
   * leaves the context with a valid (fresh) refresh token. The next scheduler
   * tick still re-rotates (we don't cache the id_token across ticks), but the
   * session isn't bricked by a partial failure.
   *
   * Single-flight: concurrent callers (e.g., the refresh loop + an explicit
   * tool-triggered call) await the same in-flight promise. Refresh tokens are
   * single-use, so overlapping calls would burn the same token.
   */
  async refresh(): Promise<void> {
    if (this.cleared) return;
    if (this.refreshTokenExpired()) return;
    if (this.inflightRefresh) return this.inflightRefresh;
    this.inflightRefresh = this.doRefresh();
    try {
      await this.inflightRefresh;
    } finally {
      this.inflightRefresh = null;
    }
  }

  private async doRefresh(): Promise<void> {
    let auth0Response: Auth0TokenResponse;
    try {
      auth0Response = await exchangeRefreshTokenForAuth0Tokens(
        this.auth0Config,
        this.internalTokens.refreshToken,
      );
    } catch (error) {
      logger.error(
        { error },
        "Auth0 refresh failed; keeping the context's current token state for next tick",
      );
      return;
    }
    // clear() may have fired while the rotation was in flight — the refresh
    // token Auth0 just gave us is already stale by intent, and there's no
    // point issuing further API calls that would be discarded.
    if (this.cleared) return;

    const rotationTime = Date.now();
    this.updateTokens((prev) => ({
      ...prev,
      refreshToken: auth0Response.refresh_token,
      // Idle expiry can't extend past the absolute lifetime — Auth0's
      // absolute expiry is a hard ceiling that overrides idle bumps.
      refreshTokenIdleExpiresAt: Math.min(
        rotationTime + REFRESH_TOKEN_IDLE_LIFETIME_MS,
        prev.refreshTokenAbsoluteExpiresAt,
      ),
    }));

    try {
      const cpResponse = await exchangeIdTokenForControlPlaneToken(
        this.auth0Config.apiUrl,
        auth0Response.id_token,
      );
      if (this.cleared) return;
      const dpResponse = await exchangeControlPlaneForDataPlaneToken(
        this.auth0Config.apiUrl,
        cpResponse.token,
      );
      if (this.cleared) return;

      this.updateTokens((prev) => ({
        ...prev,
        controlPlaneToken: cpResponse.token,
        controlPlaneExpiresAt: rotationTime + CONTROL_PLANE_TOKEN_LIFETIME_MS,
        dataPlaneToken: dpResponse.token,
        dataPlaneExpiresAt: rotationTime + DATA_PLANE_TOKEN_LIFETIME_MS,
      }));
      logger.debug("Token set refreshed successfully");
    } catch (error) {
      logger.error(
        { error },
        "CP/DP exchange failed; rotated refresh token preserved for next tick",
      );
    }
  }

  /**
   * Mark this context as cleared — subsequent `refresh()` is a no-op, any
   * running refresh loop is stopped, and the accessors (`getControlPlaneToken`,
   * `getDataPlaneToken`) return `undefined`. Internal state is not exposed to
   * consumers, so no field scrubbing is needed.
   */
  clear(): void {
    this.cleared = true;
    this.stopRefreshLoop();
  }

  /**
   * Starts a background loop that checks this context every `intervalMs`.
   * If the refresh token has expired, the context is cleared (loop stops).
   * If the CP token is within the refresh window, `refresh()` is invoked.
   * Ticks are single-flight — a tick that fires while another is in flight
   * is skipped.
   */
  startRefreshLoop(intervalMs: number = DEFAULT_REFRESH_INTERVAL_MS): void {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new RangeError("intervalMs must be a finite number greater than 0");
    }
    if (this.cleared) {
      // A cleared context is terminal. Starting a loop here would create a
      // timer that can never do useful work — guard against the leak.
      logger.warn("Refresh loop not started: context is cleared");
      return;
    }
    if (this.refreshInterval) {
      logger.warn("Refresh loop already running, skipping");
      return;
    }
    let tickInProgress = false;
    this.refreshInterval = setInterval(async () => {
      if (this.cleared || tickInProgress) return;
      // Single `now` per tick so the two predicates can't disagree at an
      // expiry boundary within the same evaluation.
      const now = Date.now();
      if (this.refreshTokenExpired(now)) {
        logger.info("Refresh token expired; clearing context");
        this.clear();
        return;
      }
      if (!this.shouldAttemptRefresh(now)) return;
      tickInProgress = true;
      try {
        await this.refresh();
      } catch (error) {
        logger.error({ error }, "Token refresh loop error");
      } finally {
        tickInProgress = false;
      }
    }, intervalMs);
    logger.info({ intervalMs }, "Token refresh loop started");
  }

  /** Stops the background refresh loop. Safe to call even if not started. */
  stopRefreshLoop(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
      logger.info("Token refresh loop stopped");
    }
  }

  /**
   * Applies a named transform to the token set. Each transform returns a
   * whole new {@link ConfluentTokenSet}; callers never mutate the state
   * directly.
   */
  private updateTokens(
    transform: (prev: Readonly<ConfluentTokenSet>) => ConfluentTokenSet,
  ): void {
    if (this.cleared) return;
    this.internalTokens = transform(this.internalTokens);
  }
}
