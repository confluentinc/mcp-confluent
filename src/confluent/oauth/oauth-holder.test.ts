import { AuthContext } from "@src/confluent/oauth/auth-context.js";
import { OAUTH_CALLBACK_PATH } from "@src/confluent/oauth/auth0-config.js";
import { OAuthHolder } from "@src/confluent/oauth/oauth-holder.js";
import { REFRESH_TOKEN_ABSOLUTE_LIFETIME_MS } from "@src/confluent/oauth/token-lifetimes.js";
import {
  mockFetch,
  mockHttpServer,
  mockOpen,
  type MockedFetch,
  type MockedHttpServer,
  type MockedOpen,
} from "@tests/stubs/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFullChain(fetchSpy: MockedFetch): void {
  fetchSpy.mockResolvedValueOnce(
    jsonResponse({
      id_token: "id",
      refresh_token: "refresh",
      access_token: "access",
      token_type: "Bearer",
      expires_in: 60,
    }),
  );
  fetchSpy.mockResolvedValueOnce(jsonResponse({ token: "cp" }));
  fetchSpy.mockResolvedValueOnce(jsonResponse({ token: "dp" }));
}

/**
 * Drives one PKCE round-trip end-to-end against the mocked HTTP server / open
 * spy / fetch chain. Production code wraps PKCE through the holder, so this
 * helper just shuttles the test state forward by firing the OAuth callback
 * request once the production code reaches the listening + open phase.
 *
 * Reads the *most recent* `openSpy` call so tests that drive two sequential
 * PKCE flows (e.g., a failure-then-retry) pick up the second flow's state.
 */
async function completePkce(
  httpMock: MockedHttpServer,
  openSpy: MockedOpen,
): Promise<void> {
  await httpMock.listening;
  // Two microtask flushes: the first lets the pkce-login Promise.race resolve
  // bind, the second lets `nodeOpen.open` complete so its mock URL is recorded.
  await Promise.resolve();
  await Promise.resolve();
  const openedUrl = openSpy.mock.calls.at(-1)![0];
  const state = new URL(openedUrl).searchParams.get("state")!;
  await httpMock.fireRequest(
    `${OAUTH_CALLBACK_PATH}?code=auth-code&state=${state}`,
  );
}

describe("oauth/oauth-holder.ts", () => {
  let fetchSpy: MockedFetch;

  beforeEach(() => {
    fetchSpy = mockFetch();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("constructor", () => {
    it("should not start PKCE; tokens are undefined and no browser opens", () => {
      const httpMock = mockHttpServer();
      const openSpy = mockOpen();

      const holder = new OAuthHolder("devel");
      try {
        expect(holder.getControlPlaneToken()).toBeUndefined();
        expect(holder.getDataPlaneToken()).toBeUndefined();
        // Constructor must be side-effect-free: no callback server bound, no
        // browser opened. This is the entire point of issue #413.
        expect(httpMock.spy).not.toHaveBeenCalled();
        expect(openSpy).not.toHaveBeenCalled();
      } finally {
        holder.shutdown();
      }
    });
  });

  describe("ensureLoggedIn()", () => {
    it("should drive PKCE end-to-end and populate tokens on success", async () => {
      const httpMock = mockHttpServer();
      const openSpy = mockOpen();
      stubFullChain(fetchSpy);

      const holder = new OAuthHolder("devel");
      try {
        const inFlight = holder.ensureLoggedIn();
        await completePkce(httpMock, openSpy);
        await inFlight;

        expect(holder.getControlPlaneToken()).toBe("cp");
        expect(holder.getDataPlaneToken()).toBe("dp");
        expect(openSpy).toHaveBeenCalledOnce();
      } finally {
        holder.shutdown();
      }
    });

    it("should share one in-flight PKCE flow across concurrent callers", async () => {
      const httpMock = mockHttpServer();
      const openSpy = mockOpen();
      stubFullChain(fetchSpy);

      const holder = new OAuthHolder("devel");
      try {
        const a = holder.ensureLoggedIn();
        const b = holder.ensureLoggedIn();
        const c = holder.ensureLoggedIn();
        await completePkce(httpMock, openSpy);
        await Promise.all([a, b, c]);

        // Only one browser tab; only one full token-chain fetch sequence.
        expect(openSpy).toHaveBeenCalledOnce();
        expect(fetchSpy).toHaveBeenCalledTimes(3); // auth0 + cp + dp
      } finally {
        holder.shutdown();
      }
    });

    it("should be a no-op when called again after a successful login", async () => {
      const httpMock = mockHttpServer();
      const openSpy = mockOpen();
      stubFullChain(fetchSpy);

      const holder = new OAuthHolder("devel");
      try {
        const first = holder.ensureLoggedIn();
        await completePkce(httpMock, openSpy);
        await first;

        await holder.ensureLoggedIn();
        await holder.ensureLoggedIn();

        // No additional PKCE attempts.
        expect(openSpy).toHaveBeenCalledOnce();
        expect(fetchSpy).toHaveBeenCalledTimes(3);
      } finally {
        holder.shutdown();
      }
    });

    it("should reject when PKCE fails and replay on the next call", async () => {
      const httpMock1 = mockHttpServer();
      const openSpy = mockOpen();
      // First attempt: browser open rejects → PkceLoginError("configuration").
      openSpy.mockRejectedValueOnce(new Error("browser-open-failed"));

      const holder = new OAuthHolder("devel");
      try {
        await expect(holder.ensureLoggedIn()).rejects.toThrow(
          /browser-open-failed|Failed to open browser/,
        );
        // Holder is back in Idle — tokens still undefined, no leaked state.
        expect(holder.getControlPlaneToken()).toBeUndefined();
        expect(holder.getDataPlaneToken()).toBeUndefined();
        // Sanity: the failed attempt did try to bind once.
        expect(httpMock1.spy).toHaveBeenCalledOnce();

        // Second attempt succeeds. Re-arm spies that aren't auto-restored
        // because they're test-local mocks (the `mockHttpServer` returns a
        // fresh fake each call).
        const httpMock2 = mockHttpServer();
        stubFullChain(fetchSpy);
        const second = holder.ensureLoggedIn();
        await completePkce(httpMock2, openSpy);
        await second;

        expect(holder.getControlPlaneToken()).toBe("cp");
        expect(holder.getDataPlaneToken()).toBe("dp");
        // Two PKCE flows total: failed first + successful second.
        expect(openSpy).toHaveBeenCalledTimes(2);
      } finally {
        holder.shutdown();
      }
    });

    it("should clear an expired ctx and start a fresh PKCE", async () => {
      vi.useFakeTimers({ now: 0 });
      const httpMock1 = mockHttpServer();
      const openSpy = mockOpen();
      stubFullChain(fetchSpy);

      const holder = new OAuthHolder("devel");
      try {
        const first = holder.ensureLoggedIn();
        await completePkce(httpMock1, openSpy);
        await first;
        expect(holder.getControlPlaneToken()).toBe("cp");

        // Jump past the refresh-family absolute lifetime so refreshTokenExpired()
        // returns true. Stop refresh loop first to avoid a stray timer firing.
        const ctx = (holder as unknown as { ctx: AuthContext | undefined }).ctx;
        ctx?.stopRefreshLoop();
        vi.setSystemTime(REFRESH_TOKEN_ABSOLUTE_LIFETIME_MS + 1);

        // Re-arm mocks for the fresh PKCE round-trip. Distinct cp/dp tokens
        // on the second chain so the assertion below proves the ctx was
        // rebuilt (rather than some stale cache returning the old value).
        const httpMock2 = mockHttpServer();
        fetchSpy
          .mockResolvedValueOnce(
            jsonResponse({
              id_token: "id-2",
              refresh_token: "refresh-2",
              access_token: "access-2",
              token_type: "Bearer",
              expires_in: 60,
            }),
          )
          .mockResolvedValueOnce(jsonResponse({ token: "cp-2" }))
          .mockResolvedValueOnce(jsonResponse({ token: "dp-2" }));

        const second = holder.ensureLoggedIn();
        await completePkce(httpMock2, openSpy);
        await second;

        expect(openSpy).toHaveBeenCalledTimes(2);
        expect(holder.getControlPlaneToken()).toBe("cp-2");
        expect(holder.getDataPlaneToken()).toBe("dp-2");
      } finally {
        holder.shutdown();
      }
    });

    it("should reject after shutdown without launching PKCE", async () => {
      const httpMock = mockHttpServer();
      const openSpy = mockOpen();

      const holder = new OAuthHolder("devel");
      holder.shutdown();
      await expect(holder.ensureLoggedIn()).rejects.toThrow(/shut down/);
      expect(httpMock.spy).not.toHaveBeenCalled();
      expect(openSpy).not.toHaveBeenCalled();
    });

    it("should start the refresh loop only on successful login", async () => {
      const httpMock = mockHttpServer();
      const openSpy = mockOpen();
      stubFullChain(fetchSpy);
      const startRefreshLoopSpy = vi.spyOn(
        AuthContext.prototype,
        "startRefreshLoop",
      );

      const holder = new OAuthHolder("devel");
      try {
        // No login attempted yet → refresh loop never started.
        expect(startRefreshLoopSpy).not.toHaveBeenCalled();

        const inFlight = holder.ensureLoggedIn();
        await completePkce(httpMock, openSpy);
        await inFlight;

        expect(startRefreshLoopSpy).toHaveBeenCalledOnce();
      } finally {
        holder.shutdown();
      }
    });
  });

  describe("shutdown()", () => {
    it("should be safe to call before any login attempt", () => {
      mockHttpServer();
      mockOpen();

      const holder = new OAuthHolder("devel");
      expect(() => holder.shutdown()).not.toThrow();
    });

    it("should be safe to call twice", async () => {
      const httpMock = mockHttpServer();
      const openSpy = mockOpen();
      stubFullChain(fetchSpy);

      const holder = new OAuthHolder("devel");
      const inFlight = holder.ensureLoggedIn();
      await completePkce(httpMock, openSpy);
      await inFlight;

      expect(() => {
        holder.shutdown();
        holder.shutdown();
      }).not.toThrow();
      expect(holder.getControlPlaneToken()).toBeUndefined();
    });

    it("should abort an in-flight login", async () => {
      mockHttpServer();
      mockOpen();
      stubFullChain(fetchSpy);

      const holder = new OAuthHolder("devel");
      const inFlight = holder.ensureLoggedIn();
      // Shutdown immediately — the PkceLoginError("user_aborted") path
      // settles inFlight without waiting on the 120s callback timeout.
      holder.shutdown();
      await expect(inFlight).rejects.toThrow(/aborted|shut down/);
      expect(holder.getControlPlaneToken()).toBeUndefined();
      expect(holder.getDataPlaneToken()).toBeUndefined();
    });
  });
});
