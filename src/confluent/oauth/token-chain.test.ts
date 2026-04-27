import { getAuth0Config } from "@src/confluent/oauth/auth0-config.js";
import {
  exchangeAuthCodeForTokens,
  exchangeControlPlaneForDataPlaneToken,
  exchangeIdTokenForControlPlaneToken,
  exchangeRefreshTokenForAuth0Tokens,
  executeFullTokenChain,
} from "@src/confluent/oauth/token-chain.js";
import {
  REFRESH_TOKEN_ABSOLUTE_LIFETIME_MS,
  REFRESH_TOKEN_IDLE_LIFETIME_MS,
} from "@src/confluent/oauth/token-lifetimes.js";
import { mockFetch, type MockedFetch } from "@tests/stubs/index.js";
import { beforeEach, describe, expect, it } from "vitest";

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("oauth/token-chain.ts", () => {
  let fetchSpy: MockedFetch;

  beforeEach(() => {
    fetchSpy = mockFetch();
  });

  describe("exchangeAuthCodeForTokens", () => {
    const auth0Config = getAuth0Config("devel");

    it("should exchange auth code for ID token and refresh token", async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse({
          id_token: "mock-id-token",
          refresh_token: "mock-refresh-token",
          access_token: "mock-access-token",
          token_type: "Bearer",
          expires_in: 60,
        }),
      );

      const result = await exchangeAuthCodeForTokens(
        auth0Config,
        "test-auth-code",
        "test-code-verifier",
      );

      expect(result.id_token).toBe("mock-id-token");
      expect(result.refresh_token).toBe("mock-refresh-token");

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, options] = fetchSpy.mock.calls[0]!;
      expect(url).toBe("https://login.confluent-dev.io/oauth/token");
      expect(options!.method).toBe("POST");

      const body = new URLSearchParams(options!.body as string);
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("test-auth-code");
      expect(body.get("code_verifier")).toBe("test-code-verifier");
      expect(body.get("client_id")).toBe(auth0Config.clientId);
      expect(body.get("redirect_uri")).toBe(auth0Config.callbackUrl);
    });

    it("should throw on non-200 response", async () => {
      fetchSpy.mockResolvedValue(jsonResponse({ error: "invalid_grant" }, 400));

      await expect(
        exchangeAuthCodeForTokens(auth0Config, "bad-code", "verifier"),
      ).rejects.toThrow(/Auth0 token exchange failed/);
    });

    it("should throw a timeout error when the fetch aborts", async () => {
      const timeoutError = new Error("The operation was aborted");
      timeoutError.name = "TimeoutError";
      fetchSpy.mockRejectedValue(timeoutError);

      await expect(
        exchangeAuthCodeForTokens(auth0Config, "code", "verifier"),
      ).rejects.toThrow(/Auth0 token exchange timed out/);
    });

    it("should throw when the response is missing refresh_token", async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse({
          id_token: "id",
          access_token: "a",
          token_type: "Bearer",
          expires_in: 60,
        }),
      );

      await expect(
        exchangeAuthCodeForTokens(auth0Config, "code", "verifier"),
      ).rejects.toThrow(/refresh_token/);
    });

    it("should throw when the response is missing id_token", async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse({
          refresh_token: "r",
          access_token: "a",
          token_type: "Bearer",
          expires_in: 60,
        }),
      );

      await expect(
        exchangeAuthCodeForTokens(auth0Config, "code", "verifier"),
      ).rejects.toThrow(/id_token/);
    });
  });

  describe("exchangeIdTokenForControlPlaneToken", () => {
    it("should exchange ID token for control plane token", async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse({ token: "cp-bearer-token-123" }),
      );

      const result = await exchangeIdTokenForControlPlaneToken(
        "https://devel.cpdev.cloud",
        "mock-id-token",
      );

      expect(result.token).toBe("cp-bearer-token-123");

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, options] = fetchSpy.mock.calls[0]!;
      expect(url).toBe("https://devel.cpdev.cloud/api/sessions");
      expect(options!.method).toBe("POST");
      expect((options!.headers as Record<string, string>)["Content-Type"]).toBe(
        "application/json",
      );

      const body = JSON.parse(options!.body as string);
      expect(body.id_token).toBe("mock-id-token");
    });

    it("should throw on non-200 response", async () => {
      fetchSpy.mockResolvedValue(new Response("Unauthorized", { status: 401 }));

      await expect(
        exchangeIdTokenForControlPlaneToken(
          "https://devel.cpdev.cloud",
          "bad-token",
        ),
      ).rejects.toThrow(/Control plane token exchange failed/);
    });

    it("should throw when the response is missing token", async () => {
      fetchSpy.mockResolvedValue(jsonResponse({}));

      await expect(
        exchangeIdTokenForControlPlaneToken(
          "https://devel.cpdev.cloud",
          "id-token",
        ),
      ).rejects.toThrow(/Control plane token exchange.*token/);
    });
  });

  describe("exchangeControlPlaneForDataPlaneToken", () => {
    it("should exchange control plane token for data plane token", async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse({ token: "dp-bearer-token-456" }),
      );

      const result = await exchangeControlPlaneForDataPlaneToken(
        "https://devel.cpdev.cloud",
        "cp-bearer-token-123",
      );

      expect(result.token).toBe("dp-bearer-token-456");

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, options] = fetchSpy.mock.calls[0]!;
      expect(url).toBe("https://devel.cpdev.cloud/api/access_tokens");
      expect(options!.method).toBe("POST");
      expect(
        (options!.headers as Record<string, string>)["Authorization"],
      ).toBe("Bearer cp-bearer-token-123");

      const body = JSON.parse(options!.body as string);
      expect(body).toEqual({});
    });

    it("should throw on non-200 response", async () => {
      fetchSpy.mockResolvedValue(new Response("Forbidden", { status: 403 }));

      await expect(
        exchangeControlPlaneForDataPlaneToken(
          "https://devel.cpdev.cloud",
          "bad-cp-token",
        ),
      ).rejects.toThrow(/Data plane token exchange failed/);
    });

    it("should throw when the response is missing token", async () => {
      fetchSpy.mockResolvedValue(jsonResponse({}));

      await expect(
        exchangeControlPlaneForDataPlaneToken(
          "https://devel.cpdev.cloud",
          "cp-token",
        ),
      ).rejects.toThrow(/Data plane token exchange.*token/);
    });
  });

  describe("exchangeRefreshTokenForAuth0Tokens", () => {
    const auth0Config = getAuth0Config("devel");

    it("should POST grant_type=refresh_token and return the Auth0 response", async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse({
          id_token: "new-id-token",
          refresh_token: "rotated-refresh-token",
          access_token: "new-access",
          token_type: "Bearer",
          expires_in: 60,
        }),
      );

      const result = await exchangeRefreshTokenForAuth0Tokens(
        auth0Config,
        "old-refresh-token",
      );

      expect(result.id_token).toBe("new-id-token");
      expect(result.refresh_token).toBe("rotated-refresh-token");

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, options] = fetchSpy.mock.calls[0]!;
      expect(url).toBe("https://login.confluent-dev.io/oauth/token");
      expect(options!.method).toBe("POST");

      const body = new URLSearchParams(options!.body as string);
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("old-refresh-token");
      expect(body.get("client_id")).toBe(auth0Config.clientId);
    });

    it("should throw on non-200 response", async () => {
      fetchSpy.mockResolvedValue(jsonResponse({ error: "invalid_grant" }, 400));

      await expect(
        exchangeRefreshTokenForAuth0Tokens(auth0Config, "bad-refresh"),
      ).rejects.toThrow(/Auth0 token refresh failed/);
    });

    it("should throw when the response is missing refresh_token", async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse({
          id_token: "id",
          access_token: "a",
          token_type: "Bearer",
          expires_in: 60,
        }),
      );

      await expect(
        exchangeRefreshTokenForAuth0Tokens(auth0Config, "old-refresh"),
      ).rejects.toThrow(/refresh_token/);
    });

    it("should throw when the response is missing id_token", async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse({
          refresh_token: "rotated",
          access_token: "a",
          token_type: "Bearer",
          expires_in: 60,
        }),
      );

      await expect(
        exchangeRefreshTokenForAuth0Tokens(auth0Config, "old-refresh"),
      ).rejects.toThrow(/id_token/);
    });
  });

  describe("executeFullTokenChain", () => {
    const auth0Config = getAuth0Config("devel");

    it("should run auth code → ID → CP → DP chain", async () => {
      fetchSpy
        .mockResolvedValueOnce(
          jsonResponse({
            id_token: "id-token",
            refresh_token: "refresh-token",
            access_token: "access",
            token_type: "Bearer",
            expires_in: 60,
          }),
        )
        .mockResolvedValueOnce(jsonResponse({ token: "cp-token" }))
        .mockResolvedValueOnce(jsonResponse({ token: "dp-token" }));

      const result = await executeFullTokenChain(
        auth0Config,
        "auth-code",
        "code-verifier",
      );

      expect(result.refreshToken).toBe("refresh-token");
      expect(result.controlPlaneToken).toBe("cp-token");
      expect(result.dataPlaneToken).toBe("dp-token");
      expect(result.controlPlaneExpiresAt).toBeGreaterThan(0);
      expect(result.dataPlaneExpiresAt).toBeGreaterThan(0);
      // Initial login sets both absolute (8hr) and idle (4hr)
      expect(result.refreshTokenAbsoluteExpiresAt).toBeGreaterThan(
        Date.now() + REFRESH_TOKEN_ABSOLUTE_LIFETIME_MS - 5000,
      );
      expect(result.refreshTokenIdleExpiresAt).toBeGreaterThan(
        Date.now() + REFRESH_TOKEN_IDLE_LIFETIME_MS - 5000,
      );
    });
  });
});
