import { nodeFetch } from "@src/confluent/node-deps.js";
import { getAuth0Config } from "@src/confluent/oauth/auth0-config.js";
import {
  CONTROL_PLANE_TOKEN_LIFETIME_MS,
  DATA_PLANE_TOKEN_LIFETIME_MS,
  DEFAULT_REFRESH_INTERVAL_MS,
  REFRESH_TOKEN_ABSOLUTE_LIFETIME_MS,
  REFRESH_TOKEN_IDLE_LIFETIME_MS,
} from "@src/confluent/oauth/token-lifetimes.js";
import {
  createRefreshCallback,
  refreshTokenSet,
  startAutoRefresh,
} from "@src/confluent/oauth/token-refresh.js";
import { TokenStore } from "@src/confluent/oauth/token-store.js";
import type { ConfluentTokenSet } from "@src/confluent/oauth/types.js";
import sinon from "sinon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("oauth/token-refresh.ts", () => {
  const sandbox = sinon.createSandbox();
  const auth0Config = getAuth0Config("devel");
  let fetchStub: sinon.SinonStub;
  let store: TokenStore;

  beforeEach(() => {
    fetchStub = sandbox.stub(nodeFetch, "fetch");
    store = new TokenStore();
  });

  afterEach(() => {
    store.shutdown();
    sandbox.restore();
  });

  function createTokenSet(
    overrides?: Partial<ConfluentTokenSet>,
  ): ConfluentTokenSet {
    return {
      refreshToken: "refresh-token",
      refreshTokenAbsoluteExpiresAt:
        Date.now() + REFRESH_TOKEN_ABSOLUTE_LIFETIME_MS,
      refreshTokenIdleExpiresAt: Date.now() + REFRESH_TOKEN_IDLE_LIFETIME_MS,
      controlPlaneToken: "cp-token",
      controlPlaneExpiresAt: Date.now() + CONTROL_PLANE_TOKEN_LIFETIME_MS,
      dataPlaneToken: "dp-token",
      dataPlaneExpiresAt: Date.now() + DATA_PLANE_TOKEN_LIFETIME_MS,
      accessToken: "opaque-access-token",
      ...overrides,
    };
  }

  function stubSuccessfulRefreshChain() {
    fetchStub.onCall(0).resolves(
      new Response(
        JSON.stringify({
          id_token: "new-id-token",
          refresh_token: "new-refresh-token",
          access_token: "new-access",
          token_type: "Bearer",
          expires_in: 60,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    fetchStub.onCall(1).resolves(
      new Response(JSON.stringify({ token: "new-cp-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    fetchStub.onCall(2).resolves(
      new Response(JSON.stringify({ token: "new-dp-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }

  describe("refreshTokenSet", () => {
    it("should rotate refresh + CP + DP on full success", async () => {
      const tokenSet = createTokenSet({ refreshToken: "old-refresh" });
      store.store(tokenSet);
      stubSuccessfulRefreshChain();

      const before = Date.now();
      await refreshTokenSet(
        auth0Config,
        store,
        "opaque-access-token",
        tokenSet,
      );
      const after = Date.now();

      const saved = store.get("opaque-access-token")!;
      expect(saved.refreshToken).toBe("new-refresh-token");
      expect(saved.controlPlaneToken).toBe("new-cp-token");
      expect(saved.dataPlaneToken).toBe("new-dp-token");
      // accessToken never mutates
      expect(saved.accessToken).toBe("opaque-access-token");

      // Expiry timestamps set from the post-Auth0 rotation time
      expect(saved.refreshTokenIdleExpiresAt).toBeGreaterThanOrEqual(
        before + REFRESH_TOKEN_IDLE_LIFETIME_MS,
      );
      expect(saved.refreshTokenIdleExpiresAt).toBeLessThanOrEqual(
        after + REFRESH_TOKEN_IDLE_LIFETIME_MS,
      );
      expect(saved.controlPlaneExpiresAt).toBeGreaterThanOrEqual(
        before + CONTROL_PLANE_TOKEN_LIFETIME_MS,
      );
      expect(saved.controlPlaneExpiresAt).toBeLessThanOrEqual(
        after + CONTROL_PLANE_TOKEN_LIFETIME_MS,
      );
      expect(saved.dataPlaneExpiresAt).toBeGreaterThanOrEqual(
        before + DATA_PLANE_TOKEN_LIFETIME_MS,
      );
      expect(saved.dataPlaneExpiresAt).toBeLessThanOrEqual(
        after + DATA_PLANE_TOKEN_LIFETIME_MS,
      );

      sinon.assert.calledThrice(fetchStub);
    });

    it("should leave state unchanged when Auth0 refresh fails", async () => {
      const tokenSet = createTokenSet({ refreshToken: "old-refresh" });
      store.store(tokenSet);
      fetchStub.resolves(new Response("server error", { status: 500 }));

      await refreshTokenSet(
        auth0Config,
        store,
        "opaque-access-token",
        tokenSet,
      );

      const saved = store.get("opaque-access-token")!;
      expect(saved.refreshToken).toBe("old-refresh");
      expect(saved.controlPlaneToken).toBe("cp-token");
      expect(saved.dataPlaneToken).toBe("dp-token");
    });

    it("should persist the rotated refresh token even if CP exchange fails", async () => {
      const tokenSet = createTokenSet({
        refreshToken: "old-refresh",
        controlPlaneToken: "old-cp",
        dataPlaneToken: "old-dp",
      });
      store.store(tokenSet);
      fetchStub.onCall(0).resolves(
        new Response(
          JSON.stringify({
            id_token: "new-id-token",
            refresh_token: "rotated-refresh",
            access_token: "new-access",
            token_type: "Bearer",
            expires_in: 60,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
      fetchStub
        .onCall(1)
        .resolves(new Response("bad gateway", { status: 502 }));

      await refreshTokenSet(
        auth0Config,
        store,
        "opaque-access-token",
        tokenSet,
      );

      const saved = store.get("opaque-access-token")!;
      // Critical invariant: rotated refresh is safe so next tick can retry
      expect(saved.refreshToken).toBe("rotated-refresh");
      expect(saved.controlPlaneToken).toBe("old-cp");
      expect(saved.dataPlaneToken).toBe("old-dp");
    });

    it("should persist the rotated refresh token even if DP exchange fails", async () => {
      const tokenSet = createTokenSet({
        refreshToken: "old-refresh",
        controlPlaneToken: "old-cp",
        dataPlaneToken: "old-dp",
      });
      store.store(tokenSet);
      fetchStub.onCall(0).resolves(
        new Response(
          JSON.stringify({
            id_token: "new-id-token",
            refresh_token: "rotated-refresh",
            access_token: "new-access",
            token_type: "Bearer",
            expires_in: 60,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
      fetchStub.onCall(1).resolves(
        new Response(JSON.stringify({ token: "new-cp" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      fetchStub.onCall(2).resolves(new Response("forbidden", { status: 403 }));

      await refreshTokenSet(
        auth0Config,
        store,
        "opaque-access-token",
        tokenSet,
      );

      const saved = store.get("opaque-access-token")!;
      expect(saved.refreshToken).toBe("rotated-refresh");
      // CP/DP only advance together via the final atomic update
      expect(saved.controlPlaneToken).toBe("old-cp");
      expect(saved.dataPlaneToken).toBe("old-dp");
    });

    it("should no-op if the token was removed between scan and refresh", async () => {
      const tokenSet = createTokenSet();
      // Don't store into `store` — simulates concurrent removal
      stubSuccessfulRefreshChain();

      await refreshTokenSet(
        auth0Config,
        store,
        "opaque-access-token",
        tokenSet,
      );

      expect(store.get("opaque-access-token")).toBeUndefined();
      // Auth0 call fires (already in flight) but CP/DP should not
      sinon.assert.calledOnce(fetchStub);
    });

    it("should discard phase-2 update when the token is removed after phase-1 persistence", async () => {
      const tokenSet = createTokenSet({ refreshToken: "old-refresh" });
      store.store(tokenSet);
      fetchStub.onCall(0).resolves(
        new Response(
          JSON.stringify({
            id_token: "new-id-token",
            refresh_token: "rotated-refresh",
            access_token: "new-access",
            token_type: "Bearer",
            expires_in: 60,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
      // Remove the token mid-flight, as CP is being fetched. Phase-2 will
      // still succeed but the final store.update must be a no-op.
      fetchStub.onCall(1).callsFake(async () => {
        store.remove("opaque-access-token");
        return new Response(JSON.stringify({ token: "new-cp-token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });
      fetchStub.onCall(2).resolves(
        new Response(JSON.stringify({ token: "new-dp-token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      await refreshTokenSet(
        auth0Config,
        store,
        "opaque-access-token",
        tokenSet,
      );

      expect(store.get("opaque-access-token")).toBeUndefined();
      expect(store.size).toBe(0);
      // All three phases ran even though the final update was a no-op.
      expect(fetchStub.callCount).toBe(3);
    });
  });

  describe("createRefreshCallback", () => {
    it("should do nothing when store is empty", async () => {
      const callback = createRefreshCallback(auth0Config);

      await callback(store);

      sinon.assert.notCalled(fetchStub);
    });

    it("should skip tokens with CP fresher than the refresh window", async () => {
      const callback = createRefreshCallback(auth0Config);
      store.store(
        createTokenSet({
          controlPlaneExpiresAt: Date.now() + 3 * 60 * 1000,
        }),
      );

      await callback(store);

      sinon.assert.notCalled(fetchStub);
    });

    it("should remove token sets with expired absolute refresh expiry", async () => {
      const callback = createRefreshCallback(auth0Config);
      store.store(
        createTokenSet({
          refreshTokenAbsoluteExpiresAt: Date.now() - 1000,
        }),
      );

      await callback(store);

      sinon.assert.notCalled(fetchStub);
      expect(store.size).toBe(0);
    });

    it("should remove token sets with expired idle refresh expiry", async () => {
      const callback = createRefreshCallback(auth0Config);
      store.store(
        createTokenSet({
          refreshTokenIdleExpiresAt: Date.now() - 1000,
        }),
      );

      await callback(store);

      sinon.assert.notCalled(fetchStub);
      expect(store.size).toBe(0);
    });

    it("should iterate every due token (no early exit after one refresh)", async () => {
      const callback = createRefreshCallback(auth0Config);
      store.store(
        createTokenSet({
          accessToken: "token-1",
          controlPlaneExpiresAt: Date.now() + 20_000,
        }),
      );
      store.store(
        createTokenSet({
          accessToken: "token-2",
          controlPlaneExpiresAt: Date.now() + 20_000,
        }),
      );

      // 2 tokens × 3 fetches each. callsFake builds a fresh Response per call
      // (Response bodies are single-use, so .resolves(shared) would fail on reuse).
      const auth0Body = JSON.stringify({
        id_token: "id",
        refresh_token: "rt",
        access_token: "a",
        token_type: "Bearer",
        expires_in: 60,
      });
      const cpBody = JSON.stringify({ token: "cp" });
      const dpBody = JSON.stringify({ token: "dp" });
      const jsonHeaders = { "Content-Type": "application/json" };
      fetchStub.callsFake(async () => {
        const calls = fetchStub.callCount;
        const phase = (calls - 1) % 3;
        const body = phase === 0 ? auth0Body : phase === 1 ? cpBody : dpBody;
        return new Response(body, { status: 200, headers: jsonHeaders });
      });

      await callback(store);

      expect(fetchStub.callCount).toBe(6);
      expect(store.get("token-1")!.controlPlaneToken).toBe("cp");
      expect(store.get("token-2")!.controlPlaneToken).toBe("cp");
    });
  });

  describe("startAutoRefresh", () => {
    it("should wire the refresh callback into the store loop", () => {
      const startSpy = sandbox.spy(store, "startRefreshLoop");

      startAutoRefresh(store, auth0Config);

      sinon.assert.calledOnce(startSpy);
      const [intervalMs, callback] = startSpy.firstCall.args;
      expect(intervalMs).toBe(DEFAULT_REFRESH_INTERVAL_MS);
      expect(typeof callback).toBe("function");
    });

    it("should accept a custom interval", () => {
      const startSpy = sandbox.spy(store, "startRefreshLoop");

      startAutoRefresh(store, auth0Config, 60_000);

      sinon.assert.calledOnce(startSpy);
      expect(startSpy.firstCall.args[0]).toBe(60_000);
    });
  });
});
