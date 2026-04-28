import {
  getAuth0Config,
  OAUTH_CALLBACK_PORT,
} from "@src/confluent/oauth/auth0-config.js";
import {
  PKCE_LOGIN_TIMEOUT_MS,
  runPkceLogin,
} from "@src/confluent/oauth/pkce-login.js";
import {
  mockFetch,
  mockHttpServer,
  mockOpen,
  type MockedFetch,
  type MockedHttpServer,
  type MockedOpen,
} from "@tests/stubs/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function flushMicrotasks(ticks: number): Promise<void> {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
}

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFullChain(fetchSpy: MockedFetch): void {
  // Auth0 token exchange
  fetchSpy.mockResolvedValueOnce(
    jsonResponse({
      id_token: "id-token",
      refresh_token: "refresh-token",
      access_token: "access",
      token_type: "Bearer",
      expires_in: 60,
    }),
  );
  // CP exchange
  fetchSpy.mockResolvedValueOnce(jsonResponse({ token: "cp-token" }));
  // DP exchange
  fetchSpy.mockResolvedValueOnce(jsonResponse({ token: "dp-token" }));
}

describe("oauth/pkce-login.ts", () => {
  let fetchSpy: MockedFetch;
  let openSpy: MockedOpen;
  let httpMock: MockedHttpServer;
  const auth0Config = getAuth0Config("devel");

  beforeEach(() => {
    fetchSpy = mockFetch();
    openSpy = mockOpen();
    httpMock = mockHttpServer();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("runPkceLogin", () => {
    it("should bind the callback server, open the browser, exchange the code, and return tokens", async () => {
      stubFullChain(fetchSpy);

      const loginPromise = runPkceLogin(auth0Config);

      const port = await httpMock.listening;
      expect(port).toBe(OAUTH_CALLBACK_PORT);
      await flushMicrotasks(3);
      expect(openSpy).toHaveBeenCalledTimes(1);

      const openedUrl = openSpy.mock.calls[0]![0] as string;
      const parsed = new URL(openedUrl);
      expect(parsed.origin).toBe(`https://${auth0Config.domain}`);
      expect(parsed.pathname).toBe("/authorize");
      expect(parsed.searchParams.get("client_id")).toBe(auth0Config.clientId);
      expect(parsed.searchParams.get("response_type")).toBe("code");
      expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
      expect(parsed.searchParams.get("code_challenge")).toBeTruthy();
      const state = parsed.searchParams.get("state");
      expect(state).toBeTruthy();

      // Simulate Auth0 redirecting to the callback URL.
      const cbUrl = new URL(auth0Config.callbackUrl);
      const cbPath = `${cbUrl.pathname}?code=auth-code-123&state=${state}`;
      const response = await httpMock.fireRequest(cbPath);
      expect(response.statusCode).toBe(200);

      const result = await loginPromise;
      expect(result.controlPlaneToken).toBe("cp-token");
      expect(result.dataPlaneToken).toBe("dp-token");
      expect(result.refreshToken).toBe("refresh-token");
      expect(httpMock.closed()).toBe(true);
    });

    it("should reject the request and not run the token chain if the state parameter does not match", async () => {
      vi.useFakeTimers();
      const loginPromise = runPkceLogin(auth0Config);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      await httpMock.listening;

      const response = await httpMock.fireRequest(
        `/gateway/v1/callback-local-mcp-docs?code=auth-code-123&state=wrong-state`,
      );
      expect(response.statusCode).toBe(400);

      // Attach the rejection assertion before advancing time so the rejection
      // is handled synchronously when the timer fires (avoids unhandled-rejection warning).
      const loginRejects =
        expect(loginPromise).rejects.toThrow(/timed out|timeout/i);
      // Force the timeout to fire so the promise resolves.
      await vi.advanceTimersByTimeAsync(PKCE_LOGIN_TIMEOUT_MS + 100);
      await loginRejects;
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("should reject with a port-in-use error when the callback port is already bound", async () => {
      const eaddrinuse = Object.assign(new Error("listen EADDRINUSE"), {
        code: "EADDRINUSE",
      });
      httpMock.setListenError(eaddrinuse);

      await expect(runPkceLogin(auth0Config)).rejects.toThrow(
        /port_in_use|EADDRINUSE|already in use/,
      );
    });

    it("should reject when the redirect carries an error parameter", async () => {
      const loginPromise = runPkceLogin(auth0Config);
      await httpMock.listening;
      await flushMicrotasks(1);
      const openedUrl = openSpy.mock.calls[0]![0] as string;
      const state = new URL(openedUrl).searchParams.get("state")!;

      await httpMock.fireRequest(
        `/gateway/v1/callback-local-mcp-docs?error=access_denied&state=${state}`,
      );

      await expect(loginPromise).rejects.toThrow(/access_denied|user_aborted/);
    });
  });
});
