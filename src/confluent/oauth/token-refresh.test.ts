import { afterEach, beforeEach, describe, expect, it } from "vitest";
import sinon from "sinon";
import { nodeFetch } from "@src/confluent/node-deps.js";
import { TokenStore } from "@src/confluent/oauth/token-store.js";
import { getAuth0Config } from "@src/confluent/oauth/auth0-config.js";
import {
  createRefreshCallback,
  startAutoRefresh,
} from "@src/confluent/oauth/token-refresh.js";
import type { ConfluentTokenSet } from "@src/confluent/oauth/types.js";

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
      refreshTokenExpiresAt: Date.now() + 8 * 60 * 60 * 1000,
      controlPlaneToken: "cp-token",
      controlPlaneExpiresAt: Date.now() + 5 * 60 * 1000,
      dataPlaneToken: "dp-token",
      dataPlaneExpiresAt: Date.now() + 15 * 60 * 1000,
      accessToken: "opaque-access-token",
      ...overrides,
    };
  }

  function stubSuccessfulRefreshChain() {
    // Auth0 refresh → new tokens
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
    // ID → CP
    fetchStub.onCall(1).resolves(
      new Response(JSON.stringify({ token: "new-cp-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    // CP → DP
    fetchStub.onCall(2).resolves(
      new Response(JSON.stringify({ token: "new-dp-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }

  describe("createRefreshCallback", () => {
    it("should skip tokens with CP expiry more than 1 minute away", async () => {
      const callback = createRefreshCallback(auth0Config);
      store.store(
        createTokenSet({
          controlPlaneExpiresAt: Date.now() + 3 * 60 * 1000,
        }),
      );

      await callback(store);

      sinon.assert.notCalled(fetchStub);
    });

    it("should refresh tokens when CP expiry is within 1 minute", async () => {
      const callback = createRefreshCallback(auth0Config);
      store.store(
        createTokenSet({
          controlPlaneExpiresAt: Date.now() + 30_000,
        }),
      );

      stubSuccessfulRefreshChain();

      await callback(store);

      sinon.assert.calledThrice(fetchStub);

      const updated = store.get("opaque-access-token");
      expect(updated!.controlPlaneToken).toBe("new-cp-token");
      expect(updated!.dataPlaneToken).toBe("new-dp-token");
      expect(updated!.refreshToken).toBe("new-refresh-token");
      expect(updated!.accessToken).toBe("opaque-access-token");
    });

    it("should refresh tokens when CP is already expired", async () => {
      const callback = createRefreshCallback(auth0Config);
      store.store(
        createTokenSet({
          controlPlaneExpiresAt: Date.now() - 1000,
        }),
      );

      stubSuccessfulRefreshChain();

      await callback(store);

      sinon.assert.calledThrice(fetchStub);
      expect(store.get("opaque-access-token")!.controlPlaneToken).toBe(
        "new-cp-token",
      );
    });

    it("should remove token set when refresh token has expired", async () => {
      const callback = createRefreshCallback(auth0Config);
      store.store(
        createTokenSet({
          refreshTokenExpiresAt: Date.now() - 1000,
          controlPlaneExpiresAt: Date.now() - 1000,
        }),
      );

      await callback(store);

      sinon.assert.notCalled(fetchStub);
      expect(store.get("opaque-access-token")).toBeUndefined();
      expect(store.size).toBe(0);
    });

    it("should do nothing when store is empty", async () => {
      const callback = createRefreshCallback(auth0Config);

      await callback(store);

      sinon.assert.notCalled(fetchStub);
    });

    it("should continue to next token if one fails to refresh", async () => {
      const callback = createRefreshCallback(auth0Config);

      store.store(
        createTokenSet({
          accessToken: "token-a",
          refreshToken: "refresh-a",
          controlPlaneExpiresAt: Date.now() + 10_000,
        }),
      );
      store.store(
        createTokenSet({
          accessToken: "token-b",
          refreshToken: "refresh-b",
          controlPlaneExpiresAt: Date.now() + 10_000,
        }),
      );

      // First refresh (token-a): fails at Auth0
      fetchStub
        .onCall(0)
        .resolves(new Response("bad request", { status: 400 }));
      // Second refresh (token-b): succeeds
      fetchStub.onCall(1).resolves(
        new Response(
          JSON.stringify({
            id_token: "b-id",
            refresh_token: "b-new-refresh",
            access_token: "b-access",
            token_type: "Bearer",
            expires_in: 60,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
      fetchStub.onCall(2).resolves(
        new Response(JSON.stringify({ token: "b-new-cp" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      fetchStub.onCall(3).resolves(
        new Response(JSON.stringify({ token: "b-new-dp" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      await callback(store);

      // Token A should still have old values (refresh failed)
      expect(store.get("token-a")!.controlPlaneToken).toBe("cp-token");
      // Token B should be updated
      expect(store.get("token-b")!.controlPlaneToken).toBe("b-new-cp");
    });

    it("should refresh multiple tokens that are all near expiry", async () => {
      const callback = createRefreshCallback(auth0Config);

      store.store(
        createTokenSet({
          accessToken: "token-1",
          refreshToken: "refresh-1",
          controlPlaneExpiresAt: Date.now() + 20_000,
        }),
      );
      store.store(
        createTokenSet({
          accessToken: "token-2",
          refreshToken: "refresh-2",
          controlPlaneExpiresAt: Date.now() + 20_000,
        }),
      );

      for (let i = 0; i < 2; i++) {
        const base = i * 3;
        fetchStub.onCall(base).resolves(
          new Response(
            JSON.stringify({
              id_token: `id-${i}`,
              refresh_token: `refresh-new-${i}`,
              access_token: `access-${i}`,
              token_type: "Bearer",
              expires_in: 60,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
        fetchStub.onCall(base + 1).resolves(
          new Response(JSON.stringify({ token: `cp-new-${i}` }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
        fetchStub.onCall(base + 2).resolves(
          new Response(JSON.stringify({ token: `dp-new-${i}` }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }

      await callback(store);

      expect(fetchStub.callCount).toBe(6);
      expect(store.get("token-1")!.controlPlaneToken).toBe("cp-new-0");
      expect(store.get("token-2")!.controlPlaneToken).toBe("cp-new-1");
    });
  });

  describe("startAutoRefresh", () => {
    it("should wire the refresh callback into the store loop", () => {
      const startSpy = sandbox.spy(store, "startRefreshLoop");

      startAutoRefresh(store, auth0Config);

      sinon.assert.calledOnce(startSpy);
      const [intervalMs, callback] = startSpy.firstCall.args;
      expect(intervalMs).toBe(4 * 60 * 1000);
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
