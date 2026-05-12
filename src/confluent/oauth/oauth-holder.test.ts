import { AuthContext } from "@src/confluent/oauth/auth-context.js";
import { OAUTH_CALLBACK_PATH } from "@src/confluent/oauth/auth0-config.js";
import { OAuthHolder } from "@src/confluent/oauth/oauth-holder.js";
import {
  CONTROL_PLANE_TOKEN_LIFETIME_MS,
  REFRESH_TOKEN_ABSOLUTE_LIFETIME_MS,
} from "@src/confluent/oauth/token-lifetimes.js";
import { TelemetryEvent } from "@src/confluent/telemetry.js";
import {
  mockFetch,
  mockHttpServer,
  mockOpen,
  mockTelemetryService,
  resetTelemetryService,
  stubSuccessfulChain,
  type MockedFetch,
  type MockedHttpServer,
  type MockedOpen,
  type MockedTelemetryService,
} from "@tests/stubs/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  let trackSpy: MockedTelemetryService;

  beforeEach(() => {
    fetchSpy = mockFetch();
    trackSpy = mockTelemetryService();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetTelemetryService();
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
      stubSuccessfulChain(fetchSpy);

      const holder = new OAuthHolder("devel");
      try {
        const inFlight = holder.ensureLoggedIn();
        await completePkce(httpMock, openSpy);
        await inFlight;

        expect(holder.getControlPlaneToken()).toBe("cp-token");
        expect(holder.getDataPlaneToken()).toBe("dp-token");
        expect(openSpy).toHaveBeenCalledOnce();
      } finally {
        holder.shutdown();
      }
    });

    it("should share one in-flight PKCE flow across concurrent callers", async () => {
      const httpMock = mockHttpServer();
      const openSpy = mockOpen();
      stubSuccessfulChain(fetchSpy);

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
      stubSuccessfulChain(fetchSpy);

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
        stubSuccessfulChain(fetchSpy);
        const second = holder.ensureLoggedIn();
        await completePkce(httpMock2, openSpy);
        await second;

        expect(holder.getControlPlaneToken()).toBe("cp-token");
        expect(holder.getDataPlaneToken()).toBe("dp-token");
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
      stubSuccessfulChain(fetchSpy);

      const holder = new OAuthHolder("devel");
      try {
        const first = holder.ensureLoggedIn();
        await completePkce(httpMock1, openSpy);
        await first;
        expect(holder.getControlPlaneToken()).toBe("cp-token");

        // Jump past the refresh-family absolute lifetime so refreshTokenExpired()
        // returns true. Stop refresh loop first to avoid a stray timer firing.
        const ctx = (holder as unknown as { ctx: AuthContext | undefined }).ctx;
        ctx?.stopRefreshLoop();
        vi.setSystemTime(REFRESH_TOKEN_ABSOLUTE_LIFETIME_MS + 1);

        // Re-arm mocks for the fresh PKCE round-trip. Distinct cp/dp tokens
        // on the second chain so the assertion below proves the ctx was
        // rebuilt (rather than some stale cache returning the old value).
        const httpMock2 = mockHttpServer();
        stubSuccessfulChain(fetchSpy, {
          refreshToken: "refresh-2",
          idToken: "id-2",
          cpToken: "cp-2",
          dpToken: "dp-2",
        });

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

    it("should refresh tokens (without re-launching PKCE) when CP/DP have expired but the refresh token is still alive", async () => {
      // Edge case from system sleep / clock jump: setTimeout for the refresh
      // loop is suspended during sleep; on wake, CP/DP are stale until the
      // queued refresh fires. ensureLoggedIn covers this gap by triggering an
      // on-demand refresh rather than returning success on a stale ctx.
      vi.useFakeTimers({ now: 0 });
      const httpMock = mockHttpServer();
      const openSpy = mockOpen();
      stubSuccessfulChain(fetchSpy);

      const holder = new OAuthHolder("devel");
      try {
        const first = holder.ensureLoggedIn();
        await completePkce(httpMock, openSpy);
        await first;

        // Stop the existing refresh-loop timer so it doesn't fire on its own
        // when we advance time — we're testing the gate's on-demand refresh.
        const ctx = (holder as unknown as { ctx: AuthContext }).ctx;
        ctx.stopRefreshLoop();

        // Advance past CP expiry but stay within refresh-family lifetime
        // (DP has a longer TTL — ~10min — so it's still alive at this
        // point; the gate correctly triggers refresh on either being
        // missing, so CP-only expiry is sufficient to exercise the path).
        vi.setSystemTime(CONTROL_PLANE_TOKEN_LIFETIME_MS + 1);
        expect(holder.getControlPlaneToken()).toBeUndefined();

        // Stub the refresh-token rotation chain (auth0 + cp + dp).
        stubSuccessfulChain(fetchSpy, {
          refreshToken: "refresh-2",
          idToken: "id-2",
          cpToken: "cp-2",
          dpToken: "dp-2",
        });

        await holder.ensureLoggedIn();

        // No new PKCE — refresh restored bearer tokens via the refresh-token
        // grant, no browser launched.
        expect(openSpy).toHaveBeenCalledOnce();
        expect(holder.getControlPlaneToken()).toBe("cp-2");
        expect(holder.getDataPlaneToken()).toBe("dp-2");
      } finally {
        holder.shutdown();
      }
    });

    it("should reject (without launching PKCE) when refresh fails to restore tokens", async () => {
      // Refresh attempt fails transiently (e.g., auth0 unreachable). The
      // gate surfaces a retry-friendly error so the next tool call retries.
      // Re-PKCE only happens once the failure becomes non-transient.
      vi.useFakeTimers({ now: 0 });
      const httpMock = mockHttpServer();
      const openSpy = mockOpen();
      stubSuccessfulChain(fetchSpy);

      const holder = new OAuthHolder("devel");
      try {
        const first = holder.ensureLoggedIn();
        await completePkce(httpMock, openSpy);
        await first;

        const ctx = (holder as unknown as { ctx: AuthContext }).ctx;
        ctx.stopRefreshLoop();
        vi.setSystemTime(CONTROL_PLANE_TOKEN_LIFETIME_MS + 1);

        // Refresh attempt fails on the first auth0 call.
        fetchSpy.mockRejectedValueOnce(new Error("network blip"));

        await expect(holder.ensureLoggedIn()).rejects.toThrow(
          /tokens unavailable/i,
        );

        // No re-PKCE — gate surfaced an error rather than launch a browser
        // for what may be a transient network blip.
        expect(openSpy).toHaveBeenCalledOnce();
        expect(httpMock.spy).toHaveBeenCalledOnce();
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
      stubSuccessfulChain(fetchSpy);
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

    it("should abort an in-flight login", async () => {
      mockHttpServer();
      mockOpen();
      stubSuccessfulChain(fetchSpy);

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

  describe("CCLOUD_AUTHENTICATION telemetry", () => {
    it("should track a success event with ccloud_user_id and ccloud_domain on successful login", async () => {
      const httpMock = mockHttpServer();
      const openSpy = mockOpen();
      stubSuccessfulChain(fetchSpy, {
        user: { resource_id: "u-abc123", email: "alice@example.com" },
      });

      const holder = new OAuthHolder("devel");
      try {
        const inFlight = holder.ensureLoggedIn();
        await completePkce(httpMock, openSpy);
        await inFlight;

        expect(trackSpy).toHaveBeenCalledWith(
          TelemetryEvent.CCLOUD_AUTHENTICATION,
          {
            status: "success",
            ccloudUserId: "u-abc123",
            ccloudDomain: "example.com",
          },
        );
      } finally {
        holder.shutdown();
      }
    });

    it("should track an error event with the PKCE failure reason when login fails", async () => {
      mockHttpServer();
      const openSpy = mockOpen();
      openSpy.mockRejectedValueOnce(new Error("browser-open-failed"));

      const holder = new OAuthHolder("devel");
      try {
        await expect(holder.ensureLoggedIn()).rejects.toThrow();

        expect(trackSpy).toHaveBeenCalledWith(
          TelemetryEvent.CCLOUD_AUTHENTICATION,
          {
            status: "error",
            ccloudUserId: undefined,
            ccloudDomain: undefined,
            failureReason: "configuration",
          },
        );
      } finally {
        holder.shutdown();
      }
    });

    it("should track an error event with user_aborted when shutdown races PKCE completion", async () => {
      const httpMock = mockHttpServer();
      const openSpy = mockOpen();
      stubSuccessfulChain(fetchSpy);

      const holder = new OAuthHolder("devel");
      // Race: PKCE completes, but shutdown fires before runLogin reaches the
      // post-PKCE branch. We drive PKCE forward, then shut down before the
      // token-chain promise resolves into the holder.
      const inFlight = holder.ensureLoggedIn();
      await completePkce(httpMock, openSpy);
      holder.shutdown();
      await inFlight.catch(() => undefined);

      expect(trackSpy).toHaveBeenCalledWith(
        TelemetryEvent.CCLOUD_AUTHENTICATION,
        {
          status: "error",
          ccloudUserId: undefined,
          ccloudDomain: undefined,
          failureReason: "user_aborted",
        },
      );
    });

    it("should emit success with undefined identity fields when CP response omits `user`", async () => {
      const httpMock = mockHttpServer();
      const openSpy = mockOpen();
      stubSuccessfulChain(fetchSpy);

      const holder = new OAuthHolder("devel");
      try {
        const inFlight = holder.ensureLoggedIn();
        await completePkce(httpMock, openSpy);
        await inFlight;

        expect(trackSpy).toHaveBeenCalledWith(
          TelemetryEvent.CCLOUD_AUTHENTICATION,
          {
            status: "success",
            ccloudUserId: undefined,
            ccloudDomain: undefined,
          },
        );
      } finally {
        holder.shutdown();
      }
    });
  });
});
