import type {
  Auth0Config,
  Auth0Environment,
} from "@src/confluent/oauth/types.js";

export const OAUTH_CALLBACK_HOST = "127.0.0.1";
export const OAUTH_CALLBACK_PORT = 26640;
export const OAUTH_CALLBACK_PATH = "/gateway/v1/callback-local-mcp-docs";
const OAUTH_CALLBACK_URL = `http://${OAUTH_CALLBACK_HOST}:${OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}`;
const OAUTH_SCOPES = "email openid offline_access";
const AUTH0_CONFIGS: Record<Auth0Environment, Auth0Config> = {
  devel: {
    clientId: "D8DV9ee7XrKX4ncAc6vJtBFgIzTMNgoY",
    domain: "login.confluent-dev.io",
    apiUrl: "https://devel.cpdev.cloud",
    callbackUrl: OAUTH_CALLBACK_URL,
    scopes: OAUTH_SCOPES,
  },
  stag: {
    clientId: "adtjckxmHbjddhNK36PvcXIDDbrJUMDH",
    domain: "login-stag.confluent-dev.io",
    apiUrl: "https://stag.cpdev.cloud",
    callbackUrl: OAUTH_CALLBACK_URL,
    scopes: OAUTH_SCOPES,
  },
  prod: {
    clientId: "", // TBD: not yet registered in identity-login-static
    domain: "login.confluent.io",
    apiUrl: "https://confluent.cloud",
    callbackUrl: OAUTH_CALLBACK_URL,
    scopes: OAUTH_SCOPES,
  },
};

export function getAuth0Config(environment: Auth0Environment): Auth0Config {
  return AUTH0_CONFIGS[environment];
}
