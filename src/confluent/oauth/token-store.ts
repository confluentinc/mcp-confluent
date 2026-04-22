import type { ConfluentTokenSet } from "@src/confluent/oauth/types.js";
import { logger } from "@src/logger.js";

/** Refreshable subset of {@link ConfluentTokenSet}; all fields required. */
type TokenUpdateFields = Pick<
  ConfluentTokenSet,
  | "refreshToken"
  | "refreshTokenIdleExpiresAt"
  | "controlPlaneToken"
  | "controlPlaneExpiresAt"
  | "dataPlaneToken"
  | "dataPlaneExpiresAt"
>;

export class TokenStore {
  private tokens = new Map<string, ConfluentTokenSet>();
  private refreshInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * Store a new token set. Keyed by the opaque accessToken.
   */
  store(tokenSet: ConfluentTokenSet): void {
    this.tokens.set(tokenSet.accessToken, tokenSet);
    logger.debug("Token set stored");
  }

  /**
   * Retrieve a token set by its opaque access token.
   */
  get(accessToken: string): ConfluentTokenSet | undefined {
    return this.tokens.get(accessToken);
  }

  /**
   * Remove a token set by its opaque access token.
   */
  remove(accessToken: string): void {
    this.tokens.delete(accessToken);
  }

  /**
   * Update a subset of the refreshable fields of an existing token set.
   * Returns false if the access token is not found.
   */
  update(accessToken: string, fields: Partial<TokenUpdateFields>): boolean {
    const existing = this.tokens.get(accessToken);
    if (!existing) {
      return false;
    }

    Object.assign(existing, fields);
    return true;
  }

  /**
   * Returns all stored access tokens.
   */
  getAllAccessTokens(): string[] {
    return Array.from(this.tokens.keys());
  }

  /**
   * Number of token sets in the store.
   */
  get size(): number {
    return this.tokens.size;
  }

  /**
   * Start a background refresh loop that calls the provided callback every intervalMs.
   * The callback receives this store instance.
   *
   * Ticks are single-flight enforced: if a previous tick is still running when the
   * interval fires, the new tick is skipped. This prevents two callbacks from
   * concurrently refreshing the same single-use refresh token and burning it.
   */
  startRefreshLoop(
    intervalMs: number,
    refreshCallback: (store: TokenStore) => Promise<void>,
  ): void {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new RangeError("intervalMs must be a finite number greater than 0");
    }

    if (this.refreshInterval) {
      logger.warn("Refresh loop already running, skipping");
      return;
    }

    let tickInProgress = false;
    this.refreshInterval = setInterval(async () => {
      if (tickInProgress) {
        logger.debug("Previous refresh tick still running, skipping");
        return;
      }
      tickInProgress = true;
      try {
        await refreshCallback(this);
      } catch (error) {
        logger.error({ error }, "Token refresh loop error");
      } finally {
        tickInProgress = false;
      }
    }, intervalMs);

    logger.info({ intervalMs }, "Token refresh loop started");
  }

  /**
   * Stop the background refresh loop and clear all tokens.
   */
  shutdown(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
      logger.info("Token refresh loop stopped");
    }
    this.tokens.clear();
  }
}
