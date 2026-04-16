import type {
  Auth0Config,
  Auth0TokenResponse,
  ControlPlaneTokenResponse,
  DataPlaneTokenResponse,
} from "@src/confluent/oauth/types.js";
import { nodeFetch } from "@src/confluent/node-deps.js";
import { logger } from "@src/logger.js";
import {
  CONTROL_PLANE_TOKEN_LIFETIME_MS,
  DATA_PLANE_TOKEN_LIFETIME_MS,
  REFRESH_TOKEN_ABSOLUTE_LIFETIME_MS,
  REFRESH_TOKEN_IDLE_LIFETIME_MS,
} from "@src/confluent/oauth/token-lifetimes.js";

/** Per-request timeout bounding each Auth0/Confluent HTTP call. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Result of a single token-chain execution — either the initial login
 * ({@link executeFullTokenChain}) or a subsequent refresh ({@link refreshTokenChain}).
 * Callers persist this into the token store so downstream CP/DP requests can
 * retrieve still-valid credentials.
 */
export interface TokenChainResult {
  refreshToken: string;
  /** Only set on initial login. Absent on refresh — callers must preserve the original value. */
  refreshTokenAbsoluteExpiresAt?: number;
  /** Reset on every rotation (initial login and refresh). */
  refreshTokenIdleExpiresAt: number;
  controlPlaneToken: string;
  controlPlaneExpiresAt: number;
  dataPlaneToken: string;
  dataPlaneExpiresAt: number;
}

/**
 * POSTs to the OAuth/Confluent endpoint and returns the decoded JSON body,
 * throwing a labeled error when the response is not OK. Each request is bounded
 * by {@link REQUEST_TIMEOUT_MS} so a hung Auth0/Confluent call can't stall the
 * refresh loop.
 */
async function postJson<T>(
  url: string,
  init: RequestInit,
  operation: string,
): Promise<T> {
  let response: Response;
  try {
    response = await nodeFetch.fetch(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      logger.error(`${operation} timed out`);
      throw new Error(`${operation} timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw err;
  }

  if (!response.ok) {
    const errorText = await response.text();
    logger.error({ status: response.status }, `${operation} failed`);
    throw new Error(`${operation} failed (${response.status}): ${errorText}`);
  }

  return (await response.json()) as T;
}

/**
 * Exchanges an authorization code for Auth0 tokens (ID token + refresh token).
 * This is the first step in the Confluent token chain.
 */
export async function exchangeAuthCodeForTokens(
  auth0Config: Auth0Config,
  authCode: string,
  codeVerifier: string,
): Promise<Auth0TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: auth0Config.clientId,
    code: authCode,
    code_verifier: codeVerifier,
    redirect_uri: auth0Config.callbackUrl,
  });

  return postJson<Auth0TokenResponse>(
    `https://${auth0Config.domain}/oauth/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
    "Auth0 token exchange",
  );
}

/**
 * Exchanges an Auth0 ID token for a Confluent Cloud control plane token.
 * POST {apiUrl}/api/sessions with the ID token in the body.
 */
export async function exchangeIdTokenForControlPlaneToken(
  apiUrl: string,
  idToken: string,
): Promise<ControlPlaneTokenResponse> {
  return postJson<ControlPlaneTokenResponse>(
    `${apiUrl}/api/sessions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id_token: idToken }),
    },
    "Control plane token exchange",
  );
}

/**
 * Exchanges a control plane token for a Confluent Cloud data plane token.
 * POST {apiUrl}/api/access_tokens with the CP token as Bearer auth.
 */
export async function exchangeControlPlaneForDataPlaneToken(
  apiUrl: string,
  controlPlaneToken: string,
): Promise<DataPlaneTokenResponse> {
  return postJson<DataPlaneTokenResponse>(
    `${apiUrl}/api/access_tokens`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${controlPlaneToken}`,
      },
      body: JSON.stringify({}),
    },
    "Data plane token exchange",
  );
}

/**
 * Uses a refresh token to obtain new Auth0 tokens, then derives CP and DP tokens.
 * This is used by the background refresh loop.
 */
export async function refreshTokenChain(
  auth0Config: Auth0Config,
  refreshToken: string,
): Promise<TokenChainResult> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: auth0Config.clientId,
    refresh_token: refreshToken,
  });

  const auth0Response = await postJson<Auth0TokenResponse>(
    `https://${auth0Config.domain}/oauth/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
    "Auth0 token refresh",
  );

  return deriveConfluentTokens(auth0Config, auth0Response);
}

/**
 * Runs the full token chain from an authorization code.
 * auth code → ID token + refresh token → control plane → data plane
 *
 * Sets both absolute (8hr) and idle (4hr) refresh token expiry.
 */
export async function executeFullTokenChain(
  auth0Config: Auth0Config,
  authCode: string,
  codeVerifier: string,
): Promise<TokenChainResult> {
  const auth0Response = await exchangeAuthCodeForTokens(
    auth0Config,
    authCode,
    codeVerifier,
  );

  const result = await deriveConfluentTokens(auth0Config, auth0Response);

  return {
    ...result,
    refreshTokenAbsoluteExpiresAt:
      Date.now() + REFRESH_TOKEN_ABSOLUTE_LIFETIME_MS,
  };
}

/**
 * Given Auth0 tokens, derives Confluent control plane and data plane tokens.
 * Expiration times are computed client-side using fixed durations.
 *
 * Does NOT set refreshTokenAbsoluteExpiresAt — that is only set on initial login.
 */
async function deriveConfluentTokens(
  auth0Config: Auth0Config,
  auth0Response: Auth0TokenResponse,
): Promise<TokenChainResult> {
  const cpResponse = await exchangeIdTokenForControlPlaneToken(
    auth0Config.apiUrl,
    auth0Response.id_token,
  );

  const dpResponse = await exchangeControlPlaneForDataPlaneToken(
    auth0Config.apiUrl,
    cpResponse.token,
  );

  const now = Date.now();

  return {
    refreshToken: auth0Response.refresh_token,
    refreshTokenIdleExpiresAt: now + REFRESH_TOKEN_IDLE_LIFETIME_MS,
    controlPlaneToken: cpResponse.token,
    controlPlaneExpiresAt: now + CONTROL_PLANE_TOKEN_LIFETIME_MS,
    dataPlaneToken: dpResponse.token,
    dataPlaneExpiresAt: now + DATA_PLANE_TOKEN_LIFETIME_MS,
  };
}
