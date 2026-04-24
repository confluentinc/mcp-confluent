import { nodeFetch } from "@src/confluent/node-deps.js";
import { AuthContext } from "@src/confluent/oauth/auth-context.js";
import { getAuth0Config } from "@src/confluent/oauth/auth0-config.js";
import {
  REFRESH_TOKEN_ABSOLUTE_LIFETIME_MS,
  REFRESH_TOKEN_IDLE_LIFETIME_MS,
} from "@src/confluent/oauth/token-lifetimes.js";
import type { ConfluentTokenSet } from "@src/confluent/oauth/types.js";
import sinon from "sinon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

function stubAuth0OkAt(
  fetchStub: sinon.SinonStub,
  callIndex: number,
  refreshToken: string,
  idToken: string,
): void {
  fetchStub.onCall(callIndex).resolves(
    jsonResponse({
      id_token: idToken,
      refresh_token: refreshToken,
      access_token: "access",
      token_type: "Bearer",
      expires_in: 60,
    }),
  );
}

function stubCpOkAt(
  fetchStub: sinon.SinonStub,
  callIndex: number,
  cpToken: string,
): void {
  fetchStub.onCall(callIndex).resolves(jsonResponse({ token: cpToken }));
}

function stubDpOkAt(
  fetchStub: sinon.SinonStub,
  callIndex: number,
  dpToken: string,
): void {
  fetchStub.onCall(callIndex).resolves(jsonResponse({ token: dpToken }));
}

function stubSuccessfulChain(
  fetchStub: sinon.SinonStub,
  startCall: number,
  refreshToken = "refresh-token",
  idToken = "id-token",
  cpToken = "cp-token",
  dpToken = "dp-token",
): void {
  stubAuth0OkAt(fetchStub, startCall, refreshToken, idToken);
  stubCpOkAt(fetchStub, startCall + 1, cpToken);
  stubDpOkAt(fetchStub, startCall + 2, dpToken);
}

async function newLoggedInContext(
  fetchStub: sinon.SinonStub,
  startCall = 0,
): Promise<AuthContext> {
  stubSuccessfulChain(fetchStub, startCall);
  const auth0Config = getAuth0Config("devel");
  return AuthContext.newFromInitialLogin(auth0Config, "code", "verifier");
}

describe("oauth/auth-context.ts", () => {
  const sandbox = sinon.createSandbox();
  const auth0Config = getAuth0Config("devel");
  let fetchStub: sinon.SinonStub;

  beforeEach(() => {
    fetchStub = sandbox.stub(nodeFetch, "fetch");
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe("AuthContext", () => {
    describe("newFromInitialLogin", () => {
      it("should run the full chain and populate all token fields", async () => {
        stubSuccessfulChain(fetchStub, 0);

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
        const ctx = await newLoggedInContext(fetchStub);

        expect(ctx.accessToken).toBeTruthy();
        expect(ctx.accessToken).toBe(ctx.accessToken);
      });

      it("should stamp absolute and idle refresh expiries from the login time", async () => {
        const before = Date.now();
        const ctx = await newLoggedInContext(fetchStub);
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
        const ctx = await newLoggedInContext(fetchStub);

        expect(ctx.getControlPlaneToken()).toBe("cp-token");
        expect(ctx.getDataPlaneToken()).toBe("dp-token");
      });

      it("should return undefined for CP once `now` is past CP expiry", async () => {
        const ctx = await newLoggedInContext(fetchStub);
        // Force CP's expiry into the past so Date.now() beats it.
        internals(ctx).controlPlaneExpiresAt = Date.now() - 1;

        expect(ctx.getControlPlaneToken()).toBeUndefined();
      });

      it("should return undefined for DP once `now` is past DP expiry", async () => {
        const ctx = await newLoggedInContext(fetchStub);
        // Force CP's expiry into the past so Date.now() beats it.
        internals(ctx).dataPlaneExpiresAt = Date.now() - 1;

        expect(ctx.getDataPlaneToken()).toBeUndefined();
      });

      it("should return undefined from both accessors after clear()", async () => {
        const ctx = await newLoggedInContext(fetchStub);

        ctx.clear();

        expect(ctx.getControlPlaneToken()).toBeUndefined();
        expect(ctx.getDataPlaneToken()).toBeUndefined();
      });
    });

    describe("refreshTokenExpired", () => {
      it("should be false while both expiry clocks are in the future", async () => {
        const ctx = await newLoggedInContext(fetchStub);

        expect(ctx.refreshTokenExpired()).toBe(false);
      });

      it("should be true past the absolute expiry", async () => {
        const ctx = await newLoggedInContext(fetchStub);

        expect(
          ctx.refreshTokenExpired(
            internals(ctx).refreshTokenAbsoluteExpiresAt + 1,
          ),
        ).toBe(true);
      });

      it("should be true past the idle expiry", async () => {
        const ctx = await newLoggedInContext(fetchStub);

        expect(
          ctx.refreshTokenExpired(internals(ctx).refreshTokenIdleExpiresAt + 1),
        ).toBe(true);
      });

      it("should be true after clear()", async () => {
        const ctx = await newLoggedInContext(fetchStub);

        ctx.clear();

        expect(ctx.refreshTokenExpired()).toBe(true);
      });
    });

    describe("shouldAttemptRefresh", () => {
      it("should be false when CP is fresher than the refresh window", async () => {
        const ctx = await newLoggedInContext(fetchStub);

        // Just after login, CP has ~5 min remaining, window is 30s — still fresh.
        expect(ctx.shouldAttemptRefresh()).toBe(false);
      });

      it("should be true once CP is inside the refresh window", async () => {
        const ctx = await newLoggedInContext(fetchStub);

        // 10s before CP expiry → inside the 30s window.
        expect(
          ctx.shouldAttemptRefresh(
            internals(ctx).controlPlaneExpiresAt - 10_000,
          ),
        ).toBe(true);
      });

      it("should be false when the refresh token has expired, even if CP is stale", async () => {
        const ctx = await newLoggedInContext(fetchStub);

        expect(
          ctx.shouldAttemptRefresh(
            internals(ctx).refreshTokenIdleExpiresAt + 1,
          ),
        ).toBe(false);
      });

      it("should be false after clear()", async () => {
        const ctx = await newLoggedInContext(fetchStub);

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
        const ctx = await newLoggedInContext(fetchStub);
        stubSuccessfulChain(
          fetchStub,
          3,
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
        const ctx = await newLoggedInContext(fetchStub);
        stubSuccessfulChain(fetchStub, 3, "new-refresh");
        const callsBeforeRefresh = fetchStub.callCount;

        await Promise.all([ctx.refresh(), ctx.refresh(), ctx.refresh()]);

        // Login consumed 3 fetches; refresh consumed 3 more (Auth0 + CP + DP).
        // Without single-flight, 3 concurrent refresh() calls would burn the
        // single-use refresh token 3 times.
        expect(fetchStub.callCount).toBe(callsBeforeRefresh + 3);
        expect(internals(ctx).refreshToken).toBe("new-refresh");
      });

      it("should leave state unchanged when Auth0 refresh fails", async () => {
        const ctx = await newLoggedInContext(fetchStub);
        const originalTokens = { ...internals(ctx) };
        fetchStub
          .onCall(3)
          .resolves(new Response("server error", { status: 500 }));

        await ctx.refresh();

        expect(internals(ctx)).toEqual(originalTokens);
      });

      it("should persist the rotated refresh token even when CP exchange fails", async () => {
        const ctx = await newLoggedInContext(fetchStub);
        const originalCp = internals(ctx).controlPlaneToken;
        stubAuth0OkAt(fetchStub, 3, "rotated-refresh", "new-id");
        fetchStub
          .onCall(4)
          .resolves(new Response("bad gateway", { status: 502 }));

        await ctx.refresh();

        expect(internals(ctx).refreshToken).toBe("rotated-refresh");
        expect(internals(ctx).controlPlaneToken).toBe(originalCp);
      });

      it("should persist the rotated refresh token even when DP exchange fails", async () => {
        const ctx = await newLoggedInContext(fetchStub);
        const originalDp = internals(ctx).dataPlaneToken;
        stubAuth0OkAt(fetchStub, 3, "rotated-refresh", "new-id");
        stubCpOkAt(fetchStub, 4, "new-cp");
        fetchStub
          .onCall(5)
          .resolves(new Response("forbidden", { status: 403 }));

        await ctx.refresh();

        expect(internals(ctx).refreshToken).toBe("rotated-refresh");
        expect(internals(ctx).dataPlaneToken).toBe(originalDp);
      });

      it("should bump the idle expiry when the refresh token is rotated", async () => {
        const ctx = await newLoggedInContext(fetchStub);
        const originalIdle = internals(ctx).refreshTokenIdleExpiresAt;
        stubSuccessfulChain(fetchStub, 3, "new-refresh");

        await ctx.refresh();

        expect(internals(ctx).refreshTokenIdleExpiresAt).toBeGreaterThanOrEqual(
          originalIdle,
        );
      });

      it("should cap the rotated idle expiry at the absolute lifetime", async () => {
        // Log in, then overwrite the absolute expiry to be very close so
        // a naive `now + IDLE_LIFETIME` bump would blow past it.
        const ctx = await newLoggedInContext(fetchStub);
        const absoluteExpiry = Date.now() + 1000;
        internals(ctx).refreshTokenAbsoluteExpiresAt = absoluteExpiry;
        stubSuccessfulChain(fetchStub, 3, "new-refresh");

        await ctx.refresh();

        expect(internals(ctx).refreshTokenIdleExpiresAt).toBeLessThanOrEqual(
          absoluteExpiry,
        );
      });

      it("should short-circuit after clear() fires mid-flight", async () => {
        // clear() between phase-1 (Auth0) and phase-2 (CP) should abort the
        // remaining exchanges so we don't burn API calls on a dead session.
        const ctx = await newLoggedInContext(fetchStub);
        const cpCallIndex = 4;
        stubAuth0OkAt(fetchStub, 3, "rotated-refresh", "new-id");
        fetchStub.onCall(cpCallIndex).callsFake(async () => {
          ctx.clear();
          return jsonResponse({ token: "late-cp-token" });
        });

        await ctx.refresh();

        // Phase-2 aborted after the CP fetch returned — no DP call was made.
        expect(fetchStub.callCount).toBe(cpCallIndex + 1);
      });

      it("should be a no-op after clear()", async () => {
        const ctx = await newLoggedInContext(fetchStub);
        ctx.clear();
        const callCountAfterLogin = fetchStub.callCount;

        await ctx.refresh();

        expect(fetchStub.callCount).toBe(callCountAfterLogin);
      });
    });

    describe("clear", () => {
      it("should make subsequent predicates report cleared state", async () => {
        const ctx = await newLoggedInContext(fetchStub);

        ctx.clear();

        expect(ctx.getControlPlaneToken()).toBeUndefined();
        expect(ctx.getDataPlaneToken()).toBeUndefined();
        expect(ctx.refreshTokenExpired()).toBe(true);
        expect(ctx.shouldAttemptRefresh()).toBe(false);
      });

      it("should gate both token accessors", async () => {
        const ctx = await newLoggedInContext(fetchStub);

        ctx.clear();

        expect(ctx.getControlPlaneToken()).toBeUndefined();
        expect(ctx.getDataPlaneToken()).toBeUndefined();
      });
    });
  });

  describe("startRefreshLoop / stopRefreshLoop", () => {
    let ctx: AuthContext;
    let clock: sinon.SinonFakeTimers;

    beforeEach(async () => {
      // Real timers for login — AbortSignal.timeout inside postJson needs
      // real setTimeout. Install fake timers only after the login resolves.
      ctx = await newLoggedInContext(fetchStub);
      clock = sinon.useFakeTimers({ shouldAdvanceTime: false });
    });

    afterEach(() => {
      ctx.stopRefreshLoop();
      clock.restore();
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
      const refreshStub = sandbox.stub(ctx, "refresh").resolves();

      ctx.startRefreshLoop(60_000);
      await clock.tickAsync(60_000);

      // No timer was ever created → no ticks fired.
      sinon.assert.notCalled(refreshStub);
    });

    it("should call refresh when CP is inside the refresh window", async () => {
      sandbox.stub(ctx, "shouldAttemptRefresh").returns(true);
      const refreshStub = sandbox.stub(ctx, "refresh").resolves();

      ctx.startRefreshLoop(60_000);
      await clock.tickAsync(60_000);

      sinon.assert.calledOnce(refreshStub);
    });

    it("should not call refresh when CP is still fresh", async () => {
      sandbox.stub(ctx, "shouldAttemptRefresh").returns(false);
      const refreshStub = sandbox.stub(ctx, "refresh").resolves();

      ctx.startRefreshLoop(60_000);
      await clock.tickAsync(60_000);

      sinon.assert.notCalled(refreshStub);
    });

    it("should clear and stop when the refresh token has expired", async () => {
      sandbox.stub(ctx, "refreshTokenExpired").returns(true);
      const refreshStub = sandbox.stub(ctx, "refresh").resolves();

      ctx.startRefreshLoop(60_000);
      await clock.tickAsync(60_000);
      // Clear stops the loop, so subsequent ticks are no-ops.
      await clock.tickAsync(60_000);

      sinon.assert.notCalled(refreshStub);
    });

    it("should skip a tick when the previous tick is still running", async () => {
      sandbox.stub(ctx, "shouldAttemptRefresh").returns(true);
      let resolveRefresh: () => void = () => {};
      const refreshStub = sandbox.stub(ctx, "refresh").returns(
        new Promise<void>((r) => {
          resolveRefresh = r;
        }),
      );

      ctx.startRefreshLoop(60_000);
      await clock.tickAsync(60_000);
      await clock.tickAsync(60_000);

      sinon.assert.calledOnce(refreshStub);
      resolveRefresh();
    });

    it("should fire on every interval when no tick is in flight", async () => {
      sandbox.stub(ctx, "shouldAttemptRefresh").returns(true);
      const refreshStub = sandbox.stub(ctx, "refresh").resolves();

      ctx.startRefreshLoop(60_000);
      await clock.tickAsync(60_000);
      sinon.assert.calledOnce(refreshStub);
      await clock.tickAsync(60_000);
      sinon.assert.calledTwice(refreshStub);
    });

    it("should swallow errors thrown by refresh and keep looping", async () => {
      sandbox.stub(ctx, "shouldAttemptRefresh").returns(true);
      const refreshStub = sandbox.stub(ctx, "refresh");
      refreshStub.onFirstCall().rejects(new Error("boom"));
      refreshStub.onSecondCall().resolves();

      ctx.startRefreshLoop(60_000);
      await clock.tickAsync(60_000);
      await clock.tickAsync(60_000);

      sinon.assert.calledTwice(refreshStub);
    });

    it("should stop the loop when stopRefreshLoop is called", async () => {
      sandbox.stub(ctx, "shouldAttemptRefresh").returns(true);
      const refreshStub = sandbox.stub(ctx, "refresh").resolves();
      ctx.startRefreshLoop(60_000);

      ctx.stopRefreshLoop();
      await clock.tickAsync(60_000);

      sinon.assert.notCalled(refreshStub);
    });

    it("should stop the loop when clear() is called", async () => {
      sandbox.stub(ctx, "shouldAttemptRefresh").returns(true);
      const refreshStub = sandbox.stub(ctx, "refresh").resolves();
      ctx.startRefreshLoop(60_000);

      ctx.clear();
      await clock.tickAsync(60_000);

      sinon.assert.notCalled(refreshStub);
    });
  });
});
