import {
  getAuth0Config,
  getCloudRestUrlForEnv,
  OAUTH_CALLBACK_PATH,
  OAUTH_CALLBACK_PORT,
} from "@src/confluent/oauth/auth0-config.js";
import type { Auth0Environment } from "@src/confluent/oauth/types.js";
import { describe, expect, it } from "vitest";

describe("oauth/auth0-config.ts", () => {
  describe("getAuth0Config", () => {
    it("should return devel config with correct client ID", () => {
      const config = getAuth0Config("devel");

      expect(config.clientId).toBe("D8DV9ee7XrKX4ncAc6vJtBFgIzTMNgoY");
      expect(config.domain).toBe("login.confluent-dev.io");
      expect(config.apiUrl).toBe("https://devel.cpdev.cloud");
      expect(config.callbackUrl).toBe(
        "http://127.0.0.1:26640/gateway/v1/callback-local-mcp-docs",
      );
      expect(config.scopes).toBe("email openid offline_access");
    });

    it("should return stag config with correct client ID", () => {
      const config = getAuth0Config("stag");

      expect(config.clientId).toBe("adtjckxmHbjddhNK36PvcXIDDbrJUMDH");
      expect(config.domain).toBe("login-stag.confluent-dev.io");
      expect(config.apiUrl).toBe("https://stag.cpdev.cloud");
    });

    it("should return prod config with correct API URL", () => {
      const config = getAuth0Config("prod");

      expect(config.apiUrl).toBe("https://confluent.cloud");
      expect(config.domain).toBe("login.confluent.io");
    });

    it("should use consistent callback URL across all environments", () => {
      const environments: Auth0Environment[] = ["devel", "stag", "prod"];
      const callbacks = environments.map(
        (env) => getAuth0Config(env).callbackUrl,
      );

      expect(new Set(callbacks).size).toBe(1);
      expect(callbacks[0]).toContain("127.0.0.1:26640");
    });
  });

  describe("getCloudRestUrlForEnv", () => {
    it("should return https://api.devel.cpdev.cloud for devel", () => {
      expect(getCloudRestUrlForEnv("devel")).toBe(
        "https://api.devel.cpdev.cloud",
      );
    });

    it("should return https://api.stag.cpdev.cloud for stag", () => {
      expect(getCloudRestUrlForEnv("stag")).toBe(
        "https://api.stag.cpdev.cloud",
      );
    });

    it("should return https://api.confluent.cloud for prod", () => {
      expect(getCloudRestUrlForEnv("prod")).toBe("https://api.confluent.cloud");
    });
  });

  describe("constants", () => {
    it("should export the callback port", () => {
      expect(OAUTH_CALLBACK_PORT).toBe(26640);
    });

    it("should export the callback path", () => {
      expect(OAUTH_CALLBACK_PATH).toBe("/gateway/v1/callback-local-mcp-docs");
    });
  });
});
