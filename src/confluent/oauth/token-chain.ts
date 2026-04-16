import type {
  Auth0Config,
  Auth0TokenResponse,
  ControlPlaneTokenResponse,
  DataPlaneTokenResponse,
} from "@src/confluent/oauth/types.js";
import { nodeFetch } from "@src/confluent/node-deps.js";
import { logger } from "@src/logger.js";

/** 5 minutes in milliseconds — control plane token lifetime */
const CONTROL_PLANE_TOKEN_LIFETIME_MS = 5 * 60 * 1000;

/** 10 minutes in milliseconds — data plane token lifetime */
const DATA_PLANE_TOKEN_LIFETIME_MS = 10 * 60 * 1000;

/** 8 hours in milliseconds — refresh token absolute lifetime from original login */
const REFRESH_TOKEN_ABSOLUTE_LIFETIME_MS = 8 * 60 * 60 * 1000;

/** 4 hours in milliseconds — refresh token idle timeout, resets on each rotation */
const REFRESH_TOKEN_IDLE_LIFETIME_MS = 4 * 60 * 60 * 1000;

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
 * Exchanges an authorization code for Auth0 tokens (ID token + refresh token).
 * This is the first step in the Confluent token chain.
 */
export async function exchangeAuthCodeForTokens(
  auth0Config: Auth0Config,
  authCode: string,
  codeVerifier: string,
): Promise<Auth0TokenResponse> {
  const tokenUrl = `https://${auth0Config.domain}/oauth/token`;

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: auth0Config.clientId,
    code: authCode,
    code_verifier: codeVerifier,
    redirect_uri: auth0Config.callbackUrl,
  });

  const response = await nodeFetch.fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error({ status: response.status }, "Auth0 token exchange failed");
    throw new Error(
      `Auth0 token exchange failed (${response.status}): ${errorText}`,
    );
  }

  return (await response.json()) as Auth0TokenResponse;
}

/**
 * Exchanges an Auth0 ID token for a Confluent Cloud control plane token.
 * POST {apiUrl}/api/sessions with the ID token in the body.
 */
export async function exchangeIdTokenForControlPlaneToken(
  apiUrl: string,
  idToken: string,
): Promise<ControlPlaneTokenResponse> {
  const url = `${apiUrl}/api/sessions`;

  const response = await nodeFetch.fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id_token: idToken }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error(
      { status: response.status },
      "Control plane token exchange failed",
    );
    throw new Error(
      `Control plane token exchange failed (${response.status}): ${errorText}`,
    );
  }

  return (await response.json()) as ControlPlaneTokenResponse;
}

/**
 * Exchanges a control plane token for a Confluent Cloud data plane token.
 * POST {apiUrl}/api/access_tokens with the CP token as Bearer auth.
 */
export async function exchangeControlPlaneForDataPlaneToken(
  apiUrl: string,
  controlPlaneToken: string,
): Promise<DataPlaneTokenResponse> {
  const url = `${apiUrl}/api/access_tokens`;

  const response = await nodeFetch.fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${controlPlaneToken}`,
    },
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error(
      { status: response.status },
      "Data plane token exchange failed",
    );
    throw new Error(
      `Data plane token exchange failed (${response.status}): ${errorText}`,
    );
  }

  return (await response.json()) as DataPlaneTokenResponse;
}

/**
 * Uses a refresh token to obtain new Auth0 tokens, then derives CP and DP tokens.
 * This is used by the background refresh loop.
 */
export async function refreshTokenChain(
  auth0Config: Auth0Config,
  refreshToken: string,
): Promise<TokenChainResult> {
  const tokenUrl = `https://${auth0Config.domain}/oauth/token`;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: auth0Config.clientId,
    refresh_token: refreshToken,
  });

  const response = await nodeFetch.fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error({ status: response.status }, "Auth0 token refresh failed");
    throw new Error(
      `Auth0 token refresh failed (${response.status}): ${errorText}`,
    );
  }

  const auth0Response = (await response.json()) as Auth0TokenResponse;

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
