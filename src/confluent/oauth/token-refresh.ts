import {
  exchangeControlPlaneForDataPlaneToken,
  exchangeIdTokenForControlPlaneToken,
  exchangeRefreshTokenForAuth0Tokens,
} from "@src/confluent/oauth/token-chain.js";
import {
  CONTROL_PLANE_REFRESH_WINDOW_MS,
  CONTROL_PLANE_TOKEN_LIFETIME_MS,
  DATA_PLANE_TOKEN_LIFETIME_MS,
  DEFAULT_REFRESH_INTERVAL_MS,
  REFRESH_TOKEN_IDLE_LIFETIME_MS,
} from "@src/confluent/oauth/token-lifetimes.js";
import type { TokenStore } from "@src/confluent/oauth/token-store.js";
import type {
  Auth0Config,
  ConfluentTokenSet,
} from "@src/confluent/oauth/types.js";
import { logger } from "@src/logger.js";

/** Refreshes one token set, persisting to `store` at each phase boundary. */
export async function refreshTokenSet(
  auth0Config: Auth0Config,
  store: TokenStore,
  accessToken: string,
  tokenSet: ConfluentTokenSet,
): Promise<void> {
  // Phase 1: rotate the refresh token with Auth0. Auth0 invalidates the old
  // token on success, so we persist the rotated token IMMEDIATELY before
  // attempting CP/DP exchange — otherwise a CP/DP failure would leave the
  // store with an already-burned refresh token and brick the session.
  let auth0Response;
  try {
    auth0Response = await exchangeRefreshTokenForAuth0Tokens(
      auth0Config,
      tokenSet.refreshToken,
    );
  } catch (error) {
    logger.error(
      { error },
      "Auth0 refresh failed; keeping existing stored token set for next tick",
    );
    return;
  }

  const rotationTime = Date.now();
  const rotatedIdleExpiresAt = rotationTime + REFRESH_TOKEN_IDLE_LIFETIME_MS;

  const rotationPersisted = store.update(accessToken, {
    refreshToken: auth0Response.refresh_token,
    refreshTokenIdleExpiresAt: rotatedIdleExpiresAt,
    controlPlaneToken: tokenSet.controlPlaneToken,
    controlPlaneExpiresAt: tokenSet.controlPlaneExpiresAt,
    dataPlaneToken: tokenSet.dataPlaneToken,
    dataPlaneExpiresAt: tokenSet.dataPlaneExpiresAt,
  });

  if (!rotationPersisted) {
    logger.debug(
      "Token removed during refresh; discarding rotated credentials",
    );
    return;
  }

  // Phase 2: derive new CP and DP tokens. A single-attempt failure here
  // leaves the rotated refresh token safely in the store; the next scheduler
  // tick will re-rotate and retry. Smarter retry (transient-only, bounded
  // attempts) lands in the transient/non-transient classification work.
  try {
    const cpResponse = await exchangeIdTokenForControlPlaneToken(
      auth0Config.apiUrl,
      auth0Response.id_token,
    );
    const dpResponse = await exchangeControlPlaneForDataPlaneToken(
      auth0Config.apiUrl,
      cpResponse.token,
    );

    const updated = store.update(accessToken, {
      controlPlaneToken: cpResponse.token,
      controlPlaneExpiresAt: rotationTime + CONTROL_PLANE_TOKEN_LIFETIME_MS,
      dataPlaneToken: dpResponse.token,
      dataPlaneExpiresAt: rotationTime + DATA_PLANE_TOKEN_LIFETIME_MS,
    });

    if (!updated) {
      logger.debug(
        "Token removed during refresh; discarding rotated credentials",
      );
    } else {
      logger.debug("Token set refreshed successfully");
    }
  } catch (error) {
    logger.error(
      { error },
      "CP/DP exchange failed; rotated refresh token preserved for next tick",
    );
  }
}

/**
 * Creates the refresh callback: scans the store and for each token set either
 * removes it (refresh token expired), skips it (CP still fresh), or delegates
 * to {@link refreshTokenSet}.
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

      if (
        now >= tokenSet.refreshTokenAbsoluteExpiresAt ||
        now >= tokenSet.refreshTokenIdleExpiresAt
      ) {
        logger.info("Refresh token expired, removing token set");
        store.remove(accessToken);
        continue;
      }

      if (
        tokenSet.controlPlaneExpiresAt - now >
        CONTROL_PLANE_REFRESH_WINDOW_MS
      ) {
        continue;
      }

      await refreshTokenSet(auth0Config, store, accessToken, tokenSet);
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
