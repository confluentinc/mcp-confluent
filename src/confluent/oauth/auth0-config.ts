import type {
  Auth0Config,
  Auth0Environment,
} from "@src/confluent/oauth/types.js";

export const OAUTH_CALLBACK_HOST = "127.0.0.1";
export const OAUTH_CALLBACK_PORT = 26640;
export const OAUTH_CALLBACK_PATH = "/gateway/v1/callback-local-mcp-docs";
const OAUTH_CALLBACK_URL = `http://${OAUTH_CALLBACK_HOST}:${OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}`;
const OAUTH_SCOPES = "email openid offline_access";

/**
 * The Confluent Cloud base domain per Auth0 environment. Every CCloud REST
 * surface this server reaches is the same domain with a different prefix
 * (`api.`, `api.telemetry.`, regional `flink.<region>.<cloud>.`), so the base
 * domain is the single source of truth and each surface's URL is derived from
 * it (see the `get*UrlForEnv` helpers below). `devel`/`stag` are
 * internal-dev-only; a wrong derived URL there is a one-line fix here.
 */
const CCLOUD_DOMAINS: Record<Auth0Environment, string> = {
  devel: "devel.cpdev.cloud",
  stag: "stag.cpdev.cloud",
  prod: "confluent.cloud",
};

/**
 * Per-environment Auth0 login identity. These are the only values that do NOT
 * derive from {@link CCLOUD_DOMAINS}: login lives on a separate domain family
 * (`login.confluent.io` / `login-stag.confluent-dev.io`) and the client ids are
 * opaque Auth0 application identifiers.
 */
const AUTH0_CLIENTS: Record<
  Auth0Environment,
  { clientId: string; domain: string }
> = {
  devel: {
    clientId: "D8DV9ee7XrKX4ncAc6vJtBFgIzTMNgoY",
    domain: "login.confluent-dev.io",
  },
  stag: {
    clientId: "adtjckxmHbjddhNK36PvcXIDDbrJUMDH",
    domain: "login-stag.confluent-dev.io",
  },
  prod: {
    clientId: "cZ0wejEDJLNocYDJ54mAmGK21klrv21h",
    domain: "login.confluent.io",
  },
};

/**
 * Returns the Confluent Cloud session/login API base URL (no `api.` prefix) for
 * the given Auth0 environment — the host that serves `/api/sessions` and
 * `/api/access_tokens` during the token-exchange chain.
 */
export function getApiUrlForEnv(environment: Auth0Environment): string {
  return `https://${CCLOUD_DOMAINS[environment]}`;
}

/**
 * Returns the Confluent Cloud REST API base URL (`api.` prefix) for the given
 * Auth0 environment. Used by {@link OAuthClientManager} to derive the cloud
 * surface's base URL when the OAuth path doesn't carry an explicit
 * `confluent_cloud.endpoint`.
 */
export function getCloudRestUrlForEnv(environment: Auth0Environment): string {
  return `https://api.${CCLOUD_DOMAINS[environment]}`;
}

/**
 * Returns the Confluent Cloud Telemetry REST API base URL
 * (`api.telemetry.` prefix) for the given Auth0 environment. Used by
 * {@link OAuthClientManager} to point the telemetry/metrics surface at the
 * right host under OAuth.
 */
export function getTelemetryRestUrlForEnv(
  environment: Auth0Environment,
): string {
  return `https://api.telemetry.${CCLOUD_DOMAINS[environment]}`;
}

export function getAuth0Config(environment: Auth0Environment): Auth0Config {
  return {
    ...AUTH0_CLIENTS[environment],
    apiUrl: getApiUrlForEnv(environment),
    callbackUrl: OAUTH_CALLBACK_URL,
    scopes: OAUTH_SCOPES,
  };
}
