import { describe, expect, it } from "vitest";
import type {
  Auth0Environment,
  Auth0TokenResponse,
  ConfluentTokenSet,
  ControlPlaneTokenResponse,
  DataPlaneTokenResponse,
  OAuthConfig,
} from "@src/confluent/oauth/types.js";

describe("oauth/types.ts", () => {
  describe("ConfluentTokenSet", () => {
    it("should be constructable with all required fields", () => {
      const tokenSet: ConfluentTokenSet = {
        refreshToken: "refresh-abc",
        refreshTokenAbsoluteExpiresAt: Date.now() + 8 * 60 * 60 * 1000,
        refreshTokenIdleExpiresAt: Date.now() + 4 * 60 * 60 * 1000,
        controlPlaneToken: "cp-token",
        controlPlaneExpiresAt: Date.now() + 5 * 60 * 1000,
        dataPlaneToken: "dp-token",
        dataPlaneExpiresAt: Date.now() + 10 * 60 * 1000,
        accessToken: "opaque-token",
      };

      expect(tokenSet.refreshToken).toBe("refresh-abc");
      expect(tokenSet.accessToken).toBe("opaque-token");
    });
  });

  describe("OAuthConfig", () => {
    it("should accept valid environment values", () => {
      const environments: Auth0Environment[] = ["devel", "stag", "prod"];
      for (const env of environments) {
        const config: OAuthConfig = { auth: "oauth", environment: env };
        expect(config.environment).toBe(env);
      }
    });
  });

  describe("Auth0TokenResponse", () => {
    it("should match expected Auth0 response shape", () => {
      const response: Auth0TokenResponse = {
        id_token: "eyJ...",
        refresh_token: "v1.MZpf...",
        access_token: "access...",
        token_type: "Bearer",
        expires_in: 60,
      };

      expect(response.id_token).toBe("eyJ...");
      expect(response.expires_in).toBe(60);
    });
  });

  describe("ControlPlaneTokenResponse", () => {
    it("should match expected control plane response shape", () => {
      const response: ControlPlaneTokenResponse = {
        token: "cp-bearer-token",
        expires_at: "2026-04-15T12:05:00Z",
      };

      expect(response.token).toBe("cp-bearer-token");
    });
  });

  describe("DataPlaneTokenResponse", () => {
    it("should match expected data plane response shape", () => {
      const response: DataPlaneTokenResponse = {
        token: "dp-bearer-token",
        expires_at: "2026-04-15T12:10:00Z",
      };

      expect(response.token).toBe("dp-bearer-token");
    });
  });
});
