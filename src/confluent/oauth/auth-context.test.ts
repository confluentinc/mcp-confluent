import { AuthContext } from "@src/confluent/oauth/auth-context.js";
import { getAuth0Config } from "@src/confluent/oauth/auth0-config.js";
import {
  MAX_CONSECUTIVE_TRANSIENT_FAILURES,
  REFRESH_TOKEN_ABSOLUTE_LIFETIME_MS,
  REFRESH_TOKEN_IDLE_LIFETIME_MS,
} from "@src/confluent/oauth/token-lifetimes.js";
import type { ConfluentTokenSet } from "@src/confluent/oauth/types.js";
import { MockedFetch, mockFetch } from "@tests/stubs/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Test-only access to the context's private token state. Production callers
 * read tokens through {@link AuthContext.getControlPlaneToken} /
 * {@link AuthContext.getDataPlaneToken}; tests occasionally need to assert on
 * internal fields (raw refresh token value, expiry timestamps) that aren't
 * exposed by accessors.
 */
function internals(ctx: AuthContext): ConfluentTokenSet {
  return (ctx as unknown as { internalTokens: ConfluentTokenSet })
    .internalTokens;
}

function stubAuth0Ok(
  fetchSpy: MockedFetch,
  refreshToken: string,
  idToken: string,
): void {
  fetchSpy.mockResolvedValueOnce(
    jsonResponse({
      id_token: idToken,
      refresh_token: refreshToken,
      access_token: "access",
      token_type: "Bearer",
      expires_in: 60,
    }),
  );
}

function stubCpOk(fetchSpy: MockedFetch, cpToken: string): void {
  fetchSpy.mockResolvedValueOnce(jsonResponse({ token: cpToken }));
}

function stubDpOk(fetchSpy: MockedFetch, dpToken: string): void {
  fetchSpy.mockResolvedValueOnce(jsonResponse({ token: dpToken }));
}

function stubSuccessfulChain(
  fetchSpy: MockedFetch,
  refreshToken = "refresh-token",
  idToken = "id-token",
  cpToken = "cp-token",
  dpToken = "dp-token",
): void {
  stubAuth0Ok(fetchSpy, refreshToken, idToken);
  stubCpOk(fetchSpy, cpToken);
  stubDpOk(fetchSpy, dpToken);
}

async function newLoggedInContext(fetchSpy: MockedFetch): Promise<AuthContext> {
  stubSuccessfulChain(fetchSpy);
  const auth0Config = getAuth0Config("devel");
  return AuthContext.newFromInitialLogin(auth0Config, "code", "verifier");
}

describe("oauth/auth-context.ts", () => {
  const auth0Config = getAuth0Config("devel");
  let fetchSpy: MockedFetch;

  beforeEach(() => {
    fetchSpy = mockFetch();
  });

  describe("AuthContext", () => {
    describe("newFromInitialLogin", () => {
      it("should run the full chain and populate all token fields", async () => {
        stubSuccessfulChain(fetchSpy);

        const ctx = await AuthContext.newFromInitialLogin(
          auth0Config,
          "code",
          "verifier",
        );

        expect(internals(ctx).refreshToken).toBe("refresh-token");
        expect(ctx.getControlPlaneToken()).toBe("cp-token");
        expect(ctx.getDataPlaneToken()).toBe("dp-token");
      });

      it("should generate an opaque accessToken that is stable across reads", async () => {
        const ctx = await newLoggedInContext(fetchSpy);

        expect(ctx.accessToken).toBeTruthy();
        expect(ctx.accessToken).toBe(ctx.accessToken);
      });

      it("should stamp absolute and idle refresh expiries from the login time", async () => {
        const before = Date.now();
        const ctx = await newLoggedInContext(fetchSpy);
        const after = Date.now();

        const tokens = internals(ctx);
        expect(tokens.refreshTokenAbsoluteExpiresAt).toBeGreaterThanOrEqual(
          before + REFRESH_TOKEN_ABSOLUTE_LIFETIME_MS,
        );
        expect(tokens.refreshTokenAbsoluteExpiresAt).toBeLessThanOrEqual(
          after + REFRESH_TOKEN_ABSOLUTE_LIFETIME_MS,
        );
        expect(tokens.refreshTokenIdleExpiresAt).toBeGreaterThanOrEqual(
          before + REFRESH_TOKEN_IDLE_LIFETIME_MS,
        );
        expect(tokens.refreshTokenIdleExpiresAt).toBeLessThanOrEqual(
          after + REFRESH_TOKEN_IDLE_LIFETIME_MS,
        );
      });
    });

    describe("getControlPlaneToken / getDataPlaneToken", () => {
      it("should return the current tokens right after login", async () => {
        const ctx = await newLoggedInContext(fetchSpy);

        expect(ctx.getControlPlaneToken()).toBe("cp-token");
        expect(ctx.getDataPlaneToken()).toBe("dp-token");
      });

      it("should return undefined for CP once `now` is past CP expiry", async () => {
        const ctx = await newLoggedInContext(fetchSpy);
        // Force CP's expiry into the past so Date.now() beats it.
        internals(ctx).controlPlaneExpiresAt = Date.now() - 1;

        expect(ctx.getControlPlaneToken()).toBeUndefined();
      });

      it("should return undefined for DP once `now` is past DP expiry", async () => {
        const ctx = await newLoggedInContext(fetchSpy);
        // Force CP's expiry into the past so Date.now() beats it.
        internals(ctx).dataPlaneExpiresAt = Date.now() - 1;

        expect(ctx.getDataPlaneToken()).toBeUndefined();
      });

      it("should return undefined from both accessors after clear()", async () => {
        const ctx = await newLoggedInContext(fetchSpy);

        ctx.clear();

        expect(ctx.getControlPlaneToken()).toBeUndefined();
        expect(ctx.getDataPlaneToken()).toBeUndefined();
      });
    });

    describe("refreshTokenExpired", () => {
      it("should be false while both expiry clocks are in the future", async () => {
        const ctx = await newLoggedInContext(fetchSpy);

        expect(ctx.refreshTokenExpired()).toBe(false);
      });

      it("should be true past the absolute expiry", async () => {
        const ctx = await newLoggedInContext(fetchSpy);

        expect(
          ctx.refreshTokenExpired(
            internals(ctx).refreshTokenAbsoluteExpiresAt + 1,
          ),
        ).toBe(true);
      });

      it("should be true past the idle expiry", async () => {
        const ctx = await newLoggedInContext(fetchSpy);

        expect(
          ctx.refreshTokenExpired(internals(ctx).refreshTokenIdleExpiresAt + 1),
        ).toBe(true);
      });

      it("should be true after clear()", async () => {
        const ctx = await newLoggedInContext(fetchSpy);

        ctx.clear();

        expect(ctx.refreshTokenExpired()).toBe(true);
      });
    });

    describe("shouldAttemptRefresh", () => {
      it("should be false when CP is fresher than the refresh window", async () => {
        const ctx = await newLoggedInContext(fetchSpy);

        // Just after login, CP has ~5 min remaining, window is 30s - still fresh.
        expect(ctx.shouldAttemptRefresh()).toBe(false);
      });

      it("should be true once CP is inside the refresh window", async () => {
        const ctx = await newLoggedInContext(fetchSpy);

        // 10s before CP expiry → inside the 30s window.
        expect(
          ctx.shouldAttemptRefresh(
            internals(ctx).controlPlaneExpiresAt - 10_000,
          ),
        ).toBe(true);
      });

      it("should be false when the refresh token has expired, even if CP is stale", async () => {
        const ctx = await newLoggedInContext(fetchSpy);

        expect(
          ctx.shouldAttemptRefresh(
            internals(ctx).refreshTokenIdleExpiresAt + 1,
          ),
        ).toBe(false);
      });

      it("should be false after clear()", async () => {
        const ctx = await newLoggedInContext(fetchSpy);

        ctx.clear();

        expect(
          ctx.shouldAttemptRefresh(
            internals(ctx).controlPlaneExpiresAt - 10_000,
          ),
        ).toBe(false);
      });
    });

    describe("refresh", () => {
      it("should rotate refresh + CP + DP on full success", async () => {
        const ctx = await newLoggedInContext(fetchSpy);
        stubSuccessfulChain(
          fetchSpy,
          "new-refresh",
          "new-id",
          "new-cp",
          "new-dp",
        );

        await ctx.refresh();

        expect(internals(ctx).refreshToken).toBe("new-refresh");
        expect(ctx.getControlPlaneToken()).toBe("new-cp");
        expect(ctx.getDataPlaneToken()).toBe("new-dp");
      });

      it("should coalesce concurrent callers into a single Auth0 rotation", async () => {
        const ctx = await newLoggedInContext(fetchSpy);
        stubSuccessfulChain(fetchSpy, "new-refresh");
        const callsBeforeRefresh = fetchSpy.mock.calls.length;

        await Promise.all([ctx.refresh(), ctx.refresh(), ctx.refresh()]);

        // Login consumed 3 fetches; refresh consumed 3 more (Auth0 + CP + DP).
        // Without single-flight, 3 concurrent refresh() calls would burn the
        // single-use refresh token 3 times.
        expect(fetchSpy.mock.calls.length).toBe(callsBeforeRefresh + 3);
        expect(internals(ctx).refreshToken).toBe("new-refresh");
      });

      it("should leave state unchanged when Auth0 refresh fails", async () => {
        const ctx = await newLoggedInContext(fetchSpy);
        const originalTokens = { ...internals(ctx) };
        fetchSpy.mockResolvedValueOnce(
          new Response("server error", { status: 500 }),
        );

        await ctx.refresh();

        expect(internals(ctx)).toEqual(originalTokens);
      });

      it("should persist the rotated refresh token even when CP exchange fails", async () => {
        const ctx = await newLoggedInContext(fetchSpy);
        const originalCp = internals(ctx).controlPlaneToken;
        stubAuth0Ok(fetchSpy, "rotated-refresh", "new-id");
        fetchSpy.mockResolvedValueOnce(
          new Response("bad gateway", { status: 502 }),
        );

        await ctx.refresh();

        expect(internals(ctx).refreshToken).toBe("rotated-refresh");
        expect(internals(ctx).controlPlaneToken).toBe(originalCp);
      });

      it("should persist the rotated refresh token even when DP exchange fails", async () => {
        const ctx = await newLoggedInContext(fetchSpy);
        const originalDp = internals(ctx).dataPlaneToken;
        stubAuth0Ok(fetchSpy, "rotated-refresh", "new-id");
        stubCpOk(fetchSpy, "new-cp");
        fetchSpy.mockResolvedValueOnce(
          new Response("forbidden", { status: 403 }),
        );

        await ctx.refresh();

        expect(internals(ctx).refreshToken).toBe("rotated-refresh");
        expect(internals(ctx).dataPlaneToken).toBe(originalDp);
      });

      it("should bump the idle expiry when the refresh token is rotated", async () => {
        const ctx = await newLoggedInContext(fetchSpy);
        const originalIdle = internals(ctx).refreshTokenIdleExpiresAt;
        stubSuccessfulChain(fetchSpy, "new-refresh");

        await ctx.refresh();

        expect(internals(ctx).refreshTokenIdleExpiresAt).toBeGreaterThanOrEqual(
          originalIdle,
        );
      });

      it("should cap the rotated idle expiry at the absolute lifetime", async () => {
        // Log in, then overwrite the absolute expiry to be very close so
        // a naive `now + IDLE_LIFETIME` bump would blow past it.
        const ctx = await newLoggedInContext(fetchSpy);
        const absoluteExpiry = Date.now() + 1000;
        internals(ctx).refreshTokenAbsoluteExpiresAt = absoluteExpiry;
        stubSuccessfulChain(fetchSpy, "new-refresh");

        await ctx.refresh();

        expect(internals(ctx).refreshTokenIdleExpiresAt).toBeLessThanOrEqual(
          absoluteExpiry,
        );
      });

      it("should short-circuit after clear() fires mid-flight", async () => {
        // clear() between phase-1 (Auth0) and phase-2 (CP) should abort the
        // remaining exchanges so we don't burn API calls on a dead session.
        const ctx = await newLoggedInContext(fetchSpy);
        stubAuth0Ok(fetchSpy, "rotated-refresh", "new-id");
        fetchSpy.mockImplementationOnce(async () => {
          ctx.clear();
          return jsonResponse({ token: "late-cp-token" });
        });
        const callsBeforeRefresh = fetchSpy.mock.calls.length;

        await ctx.refresh();

        // Phase-2 aborted after the CP fetch returned - no DP call was made.
        // Refresh consumed 2 fetches (Auth0 + CP), not 3.
        expect(fetchSpy.mock.calls.length).toBe(callsBeforeRefresh + 2);
      });

      it("should be a no-op after clear()", async () => {
        const ctx = await newLoggedInContext(fetchSpy);
        ctx.clear();
        const callCountAfterLogin = fetchSpy.mock.calls.length;

        await ctx.refresh();

        expect(fetchSpy.mock.calls.length).toBe(callCountAfterLogin);
      });

      it("should be a no-op when the refresh token is already expired", async () => {
        const ctx = await newLoggedInContext(fetchSpy);
        // Force the absolute refresh-token expiry into the past so refresh()
        // sees a dead token. Without the guard it would still hit Auth0 and
        // get a confusing "invalid refresh token" error back.
        internals(ctx).refreshTokenAbsoluteExpiresAt = Date.now() - 1;
        const callCountAfterLogin = fetchSpy.mock.calls.length;

        await ctx.refresh();

        expect(fetchSpy.mock.calls.length).toBe(callCountAfterLogin);
      });
    });

    describe("clear", () => {
      it("should make subsequent predicates report cleared state", async () => {
        const ctx = await newLoggedInContext(fetchSpy);

        ctx.clear();

        expect(ctx.getControlPlaneToken()).toBeUndefined();
        expect(ctx.getDataPlaneToken()).toBeUndefined();
        expect(ctx.refreshTokenExpired()).toBe(true);
        expect(ctx.shouldAttemptRefresh()).toBe(false);
      });

      it("should gate both token accessors", async () => {
        const ctx = await newLoggedInContext(fetchSpy);

        ctx.clear();

        expect(ctx.getControlPlaneToken()).toBeUndefined();
        expect(ctx.getDataPlaneToken()).toBeUndefined();
      });
    });

    describe("error classification", () => {
      it("should record a transient error on a generic phase-1 failure", async () => {
        const ctx = await newLoggedInContext(fetchSpy);
        fetchSpy.mockResolvedValueOnce(
          new Response("server error", { status: 500 }),
        );

        await ctx.refresh();

        const err = ctx.getErrors().tokenRefresh;
        expect(err).toBeDefined();
        expect(err!.isTransient).toBe(true);
        expect(
          ctx.shouldAttemptRefresh(
            internals(ctx).controlPlaneExpiresAt - 10_000,
          ),
        ).toBe(true);
      });

      it("should record a non-transient error when the refresh token is revoked", async () => {
        const ctx = await newLoggedInContext(fetchSpy);
        fetchSpy.mockResolvedValueOnce(
          new Response(
            '{"error":"invalid_grant","error_description":"Unknown or invalid refresh token."}',
            { status: 400 },
          ),
        );

        await ctx.refresh();

        const err = ctx.getErrors().tokenRefresh;
        expect(err).toBeDefined();
        expect(err!.isTransient).toBe(false);
        // Scheduler must now skip this context even when CP is due.
        expect(
          ctx.shouldAttemptRefresh(
            internals(ctx).controlPlaneExpiresAt - 10_000,
          ),
        ).toBe(false);
      });

      it("should record a non-transient error on invalid_grant without the revoked-token message", async () => {
        const ctx = await newLoggedInContext(fetchSpy);
        fetchSpy.mockResolvedValueOnce(
          new Response('{"error":"invalid_grant"}', { status: 400 }),
        );

        await ctx.refresh();

        expect(ctx.getErrors().tokenRefresh!.isTransient).toBe(false);
      });

      it("should promote to non-transient after MAX_CONSECUTIVE_TRANSIENT_FAILURES", async () => {
        const ctx = await newLoggedInContext(fetchSpy);
        // N generic 500s back-to-back. Each refresh() call consumes one fetch
        // (phase 1 fails and we return before phase 2).
        for (let i = 0; i < MAX_CONSECUTIVE_TRANSIENT_FAILURES; i++) {
          fetchSpy.mockResolvedValueOnce(
            new Response("server error", { status: 500 }),
          );
          await ctx.refresh();
        }

        const err = ctx.getErrors().tokenRefresh;
        expect(err).toBeDefined();
        expect(err!.isTransient).toBe(false);
      });

      it("should clear the recorded error and reset the counter on a successful refresh", async () => {
        const ctx = await newLoggedInContext(fetchSpy);
        // First refresh fails transiently.
        fetchSpy.mockResolvedValueOnce(
          new Response("server error", { status: 500 }),
        );
        await ctx.refresh();
        expect(ctx.getErrors().tokenRefresh!.isTransient).toBe(true);

        // Next refresh succeeds.
        stubSuccessfulChain(
          fetchSpy,
          "new-refresh",
          "new-id",
          "new-cp",
          "new-dp",
        );
        await ctx.refresh();

        expect(ctx.getErrors().tokenRefresh).toBeUndefined();
        // Counter reset is observable via the classifier: a new generic failure
        // should be classified transient, not cascade from the prior counter.
        fetchSpy.mockResolvedValueOnce(
          new Response("server error", { status: 500 }),
        );
        await ctx.refresh();
        expect(ctx.getErrors().tokenRefresh!.isTransient).toBe(true);
      });

      it("should retry CP once on transient failure and succeed", async () => {
        const ctx = await newLoggedInContext(fetchSpy);
        stubAuth0Ok(fetchSpy, "new-refresh", "new-id");
        fetchSpy.mockResolvedValueOnce(
          new Response("bad gateway", { status: 502 }),
        );
        stubCpOk(fetchSpy, "retry-cp");
        stubDpOk(fetchSpy, "new-dp");

        await ctx.refresh();

        expect(ctx.getControlPlaneToken()).toBe("retry-cp");
        expect(ctx.getDataPlaneToken()).toBe("new-dp");
        expect(ctx.getErrors().tokenRefresh).toBeUndefined();
      });

      it("should retry DP once on transient failure and succeed", async () => {
        const ctx = await newLoggedInContext(fetchSpy);
        stubAuth0Ok(fetchSpy, "new-refresh", "new-id");
        stubCpOk(fetchSpy, "new-cp");
        fetchSpy.mockResolvedValueOnce(
          new Response("bad gateway", { status: 502 }),
        );
        stubDpOk(fetchSpy, "retry-dp");

        await ctx.refresh();

        expect(ctx.getDataPlaneToken()).toBe("retry-dp");
        expect(ctx.getErrors().tokenRefresh).toBeUndefined();
      });

      it("should not retry phase-2 when the error is a known non-transient signal", async () => {
        const ctx = await newLoggedInContext(fetchSpy);
        const callsBeforeRefresh = fetchSpy.mock.calls.length;
        stubAuth0Ok(fetchSpy, "new-refresh", "new-id");
        fetchSpy.mockResolvedValueOnce(
          new Response(
            '{"error":"invalid_grant","error_description":"Unknown or invalid refresh token."}',
            { status: 400 },
          ),
        );

        await ctx.refresh();

        // Only the first CP call should have fired - no retry. Refresh
        // consumed 2 fetches (Auth0 + CP), not 3.
        expect(fetchSpy.mock.calls.length).toBe(callsBeforeRefresh + 2);
        expect(ctx.getErrors().tokenRefresh!.isTransient).toBe(false);
      });
    });
  });

  describe("startRefreshLoop / stopRefreshLoop", () => {
    let ctx: AuthContext;

    beforeEach(async () => {
      // Real timers for login - AbortSignal.timeout inside postJson needs
      // real setTimeout. Install fake timers only after the login resolves.
      ctx = await newLoggedInContext(fetchSpy);
      vi.useFakeTimers();
    });

    afterEach(() => {
      ctx.stopRefreshLoop();
      vi.useRealTimers();
    });

    it("should throw on invalid intervalMs", () => {
      expect(() => ctx.startRefreshLoop(0)).toThrow(RangeError);
      expect(() => ctx.startRefreshLoop(-1)).toThrow(RangeError);
      expect(() => ctx.startRefreshLoop(NaN)).toThrow(RangeError);
      expect(() => ctx.startRefreshLoop(Infinity)).toThrow(RangeError);
    });

    it("should warn and skip when already running", () => {
      ctx.startRefreshLoop(60_000);
      ctx.startRefreshLoop(60_000);
    });

    it("should be a no-op when the context is already cleared", async () => {
      ctx.clear();
      const refreshSpy = vi.spyOn(ctx, "refresh").mockResolvedValue();

      ctx.startRefreshLoop(60_000);
      await vi.advanceTimersByTimeAsync(60_000);

      // No timer was ever created → no ticks fired.
      expect(refreshSpy).not.toHaveBeenCalled();
    });

    it("should call refresh when CP is inside the refresh window", async () => {
      vi.spyOn(ctx, "shouldAttemptRefresh").mockReturnValue(true);
      const refreshSpy = vi.spyOn(ctx, "refresh").mockResolvedValue();

      ctx.startRefreshLoop(60_000);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(refreshSpy).toHaveBeenCalledOnce();
    });

    it("should not call refresh when CP is still fresh", async () => {
      vi.spyOn(ctx, "shouldAttemptRefresh").mockReturnValue(false);
      const refreshSpy = vi.spyOn(ctx, "refresh").mockResolvedValue();

      ctx.startRefreshLoop(60_000);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(refreshSpy).not.toHaveBeenCalled();
    });

    it("should clear and stop when the refresh token has expired", async () => {
      vi.spyOn(ctx, "refreshTokenExpired").mockReturnValue(true);
      const refreshSpy = vi.spyOn(ctx, "refresh").mockResolvedValue();

      ctx.startRefreshLoop(60_000);
      await vi.advanceTimersByTimeAsync(60_000);
      // Clear stops the loop, so subsequent ticks are no-ops.
      await vi.advanceTimersByTimeAsync(60_000);

      expect(refreshSpy).not.toHaveBeenCalled();
    });

    it("should skip a tick when the previous tick is still running", async () => {
      vi.spyOn(ctx, "shouldAttemptRefresh").mockReturnValue(true);
      let resolveRefresh: () => void = () => {};
      const refreshSpy = vi.spyOn(ctx, "refresh").mockReturnValue(
        new Promise<void>((r) => {
          resolveRefresh = r;
        }),
      );

      ctx.startRefreshLoop(60_000);
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(refreshSpy).toHaveBeenCalledOnce();
      resolveRefresh();
    });

    it("should fire on every interval when no tick is in flight", async () => {
      vi.spyOn(ctx, "shouldAttemptRefresh").mockReturnValue(true);
      const refreshSpy = vi.spyOn(ctx, "refresh").mockResolvedValue();

      ctx.startRefreshLoop(60_000);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(refreshSpy).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(refreshSpy).toHaveBeenCalledTimes(2);
    });

    it("should swallow errors thrown by refresh and keep looping", async () => {
      vi.spyOn(ctx, "shouldAttemptRefresh").mockReturnValue(true);
      const refreshSpy = vi
        .spyOn(ctx, "refresh")
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValueOnce();

      ctx.startRefreshLoop(60_000);
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(refreshSpy).toHaveBeenCalledTimes(2);
    });

    it("should stop the loop when stopRefreshLoop is called", async () => {
      vi.spyOn(ctx, "shouldAttemptRefresh").mockReturnValue(true);
      const refreshSpy = vi.spyOn(ctx, "refresh").mockResolvedValue();
      ctx.startRefreshLoop(60_000);

      ctx.stopRefreshLoop();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(refreshSpy).not.toHaveBeenCalled();
    });

    it("should stop the loop when clear() is called", async () => {
      vi.spyOn(ctx, "shouldAttemptRefresh").mockReturnValue(true);
      const refreshSpy = vi.spyOn(ctx, "refresh").mockResolvedValue();
      ctx.startRefreshLoop(60_000);

      ctx.clear();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(refreshSpy).not.toHaveBeenCalled();
    });
  });
});
