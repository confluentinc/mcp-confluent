import type { ConfluentTokenSet } from "@src/confluent/oauth/types.js";
import { logger } from "@src/logger.js";

interface TokenUpdateFields {
  refreshToken: string;
  refreshTokenExpiresAt?: number;
  controlPlaneToken: string;
  controlPlaneExpiresAt: number;
  dataPlaneToken: string;
  dataPlaneExpiresAt: number;
}

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
   * Update the refreshable fields of an existing token set.
   * Returns false if the access token is not found.
   */
  update(accessToken: string, fields: TokenUpdateFields): boolean {
    const existing = this.tokens.get(accessToken);
    if (!existing) {
      return false;
    }

    existing.refreshToken = fields.refreshToken;
    if (fields.refreshTokenExpiresAt !== undefined) {
      existing.refreshTokenExpiresAt = fields.refreshTokenExpiresAt;
    }
    existing.controlPlaneToken = fields.controlPlaneToken;
    existing.controlPlaneExpiresAt = fields.controlPlaneExpiresAt;
    existing.dataPlaneToken = fields.dataPlaneToken;
    existing.dataPlaneExpiresAt = fields.dataPlaneExpiresAt;

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
   */
  startRefreshLoop(
    intervalMs: number,
    refreshCallback: (store: TokenStore) => Promise<void>,
  ): void {
    if (this.refreshInterval) {
      logger.warn("Refresh loop already running, skipping");
      return;
    }

    this.refreshInterval = setInterval(async () => {
      try {
        await refreshCallback(this);
      } catch (error) {
        logger.error({ error }, "Token refresh loop error");
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
