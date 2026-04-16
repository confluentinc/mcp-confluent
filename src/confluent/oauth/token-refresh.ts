import type { Auth0Config } from "@src/confluent/oauth/types.js";
import type { TokenStore } from "@src/confluent/oauth/token-store.js";
import { refreshTokenChain } from "@src/confluent/oauth/token-chain.js";
import { DEFAULT_REFRESH_INTERVAL_MS } from "@src/confluent/oauth/token-lifetimes.js";
import { logger } from "@src/logger.js";

/**
 * Creates the refresh callback that iterates all stored token sets
 * and refreshes any whose control plane token is approaching expiry.
 *
 * For each token set:
 * - Skips if the refresh token itself has expired (removes the token set)
 * - Skips if the control plane token is still fresh (more than 1 min remaining)
 * - Calls refreshTokenChain to get new tokens and updates the store
 * - On failure, logs the error but continues to the next token set
 */
export function createRefreshCallback(
  auth0Config: Auth0Config,
): (store: TokenStore) => Promise<void> {
  return async (store: TokenStore): Promise<void> => {
    const accessTokens = store.getAllAccessTokens();

    if (accessTokens.length === 0) {
      return;
    }

    logger.debug(
      { count: accessTokens.length },
      "Refresh loop: checking tokens",
    );

    for (const accessToken of accessTokens) {
      const tokenSet = store.get(accessToken);
      if (!tokenSet) continue;

      const now = Date.now();

      // Remove if the refresh token has expired (8hr absolute or 4hr idle)
      if (
        now >= tokenSet.refreshTokenAbsoluteExpiresAt ||
        now >= tokenSet.refreshTokenIdleExpiresAt
      ) {
        logger.info("Refresh token expired, removing token set");
        store.remove(accessToken);
        continue;
      }

      // Skip if CP token still has more than 1 minute remaining
      const cpTimeRemaining = tokenSet.controlPlaneExpiresAt - now;
      if (cpTimeRemaining > 60_000) {
        continue;
      }

      try {
        const result = await refreshTokenChain(
          auth0Config,
          tokenSet.refreshToken,
        );

        store.update(accessToken, {
          refreshToken: result.refreshToken,
          refreshTokenIdleExpiresAt: result.refreshTokenIdleExpiresAt,
          controlPlaneToken: result.controlPlaneToken,
          controlPlaneExpiresAt: result.controlPlaneExpiresAt,
          dataPlaneToken: result.dataPlaneToken,
          dataPlaneExpiresAt: result.dataPlaneExpiresAt,
        });

        logger.debug("Token set refreshed successfully");
      } catch (error) {
        logger.error({ error }, "Failed to refresh token set");
      }
    }
  };
}

/**
 * Starts the auto-refresh loop on the given token store.
 * Convenience function that wires createRefreshCallback into store.startRefreshLoop.
 */
export function startAutoRefresh(
  store: TokenStore,
  auth0Config: Auth0Config,
  intervalMs: number = DEFAULT_REFRESH_INTERVAL_MS,
): void {
  const callback = createRefreshCallback(auth0Config);
  store.startRefreshLoop(intervalMs, callback);
}
