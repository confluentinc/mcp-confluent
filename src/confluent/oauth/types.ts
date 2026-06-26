export type Auth0Environment = "devel" | "stag" | "prod";

export interface Auth0Config {
  clientId: string;
  domain: string;
  /** Confluent Cloud session/login API base URL (no `api.` prefix, e.g. https://confluent.cloud for prod). Used by the token-exchange chain. */
  apiUrl: string;
  callbackUrl: string;
  scopes: string;
}

export interface ConfluentTokenSet {
  /** Auth0 refresh token — single-use, rotated each refresh cycle */
  refreshToken: string;
  /** Absolute expiration of the refresh token family (epoch ms). 8hr from original login. */
  refreshTokenAbsoluteExpiresAt: number;
  /** Idle expiration of the current refresh token (epoch ms). 4hr from last rotation. */
  refreshTokenIdleExpiresAt: number;

  /** Confluent Cloud control plane token (Bearer token for api.confluent.cloud) */
  controlPlaneToken: string;
  /** Control plane token expiration (epoch ms). ~5 min TTL. */
  controlPlaneExpiresAt: number;

  /** Confluent Cloud data plane token (Bearer token for cluster-specific endpoints) */
  dataPlaneToken: string;
  /** Data plane token expiration (epoch ms). ~10 min TTL. */
  dataPlaneExpiresAt: number;

  /** Opaque access token returned to MCP clients. Stable across refreshes. */
  accessToken: string;
}

export interface OAuthConfig {
  auth: "oauth";
  environment: Auth0Environment;
}

/**
 * Response from POST login.confluent.io/oauth/token
 */
export interface Auth0TokenResponse {
  id_token: string;
  refresh_token: string;
  access_token: string;
  token_type: string;
  expires_in: number;
}

/**
 * User identity returned in the body of POST confluent.cloud/api/sessions.
 * Sourced from the JSON response, not from any JWT claim. Fields beyond what
 * we consume are intentionally omitted.
 */
export interface UserDetails {
  id?: string;
  email?: string;
  resource_id?: string;
}

/**
 * Response from POST confluent.cloud/api/sessions
 */
export interface ControlPlaneTokenResponse {
  token: string;
  expires_at: string;
  user?: UserDetails;
}

/**
 * Response from POST confluent.cloud/api/access_tokens
 */
export interface DataPlaneTokenResponse {
  token: string;
  expires_at: string;
}
