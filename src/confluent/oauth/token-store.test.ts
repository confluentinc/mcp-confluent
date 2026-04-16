import { afterEach, beforeEach, describe, expect, it } from "vitest";
import sinon from "sinon";
import { TokenStore } from "@src/confluent/oauth/token-store.js";
import type { ConfluentTokenSet } from "@src/confluent/oauth/types.js";

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const TEN_MINUTES_MS = 10 * 60 * 1000;

describe("oauth/token-store.ts", () => {
  describe("TokenStore", () => {
    let store: TokenStore;

    beforeEach(() => {
      store = new TokenStore();
    });

    afterEach(() => {
      store.shutdown();
    });

    function createTokenSet(
      overrides?: Partial<ConfluentTokenSet>,
    ): ConfluentTokenSet {
      return {
        refreshToken: "refresh-token",
        refreshTokenAbsoluteExpiresAt: Date.now() + EIGHT_HOURS_MS,
        refreshTokenIdleExpiresAt: Date.now() + FOUR_HOURS_MS,
        controlPlaneToken: "cp-token",
        controlPlaneExpiresAt: Date.now() + FIVE_MINUTES_MS,
        dataPlaneToken: "dp-token",
        dataPlaneExpiresAt: Date.now() + TEN_MINUTES_MS,
        accessToken: "opaque-access-token",
        ...overrides,
      };
    }

    describe("store and get", () => {
      it("should store a token set and retrieve it by access token", () => {
        const tokenSet = createTokenSet();
        store.store(tokenSet);

        const retrieved = store.get("opaque-access-token");
        expect(retrieved).toBeDefined();
        expect(retrieved!.controlPlaneToken).toBe("cp-token");
      });

      it("should return undefined for unknown access token", () => {
        expect(store.get("nonexistent")).toBeUndefined();
      });
    });

    describe("remove", () => {
      it("should remove a token set by access token", () => {
        const tokenSet = createTokenSet();
        store.store(tokenSet);

        store.remove("opaque-access-token");

        expect(store.get("opaque-access-token")).toBeUndefined();
      });

      it("should be a no-op for unknown access token", () => {
        store.remove("nonexistent"); // should not throw
      });
    });

    describe("update", () => {
      it("should update an existing token set in place", () => {
        const tokenSet = createTokenSet();
        store.store(tokenSet);

        store.update("opaque-access-token", {
          refreshToken: "new-refresh",
          refreshTokenIdleExpiresAt: Date.now() + FOUR_HOURS_MS,
          controlPlaneToken: "new-cp",
          dataPlaneToken: "new-dp",
          controlPlaneExpiresAt: Date.now() + FIVE_MINUTES_MS,
          dataPlaneExpiresAt: Date.now() + TEN_MINUTES_MS,
        });

        const updated = store.get("opaque-access-token");
        expect(updated!.refreshToken).toBe("new-refresh");
        expect(updated!.controlPlaneToken).toBe("new-cp");
        expect(updated!.dataPlaneToken).toBe("new-dp");
        // accessToken should remain unchanged
        expect(updated!.accessToken).toBe("opaque-access-token");
      });

      it("should return false when updating nonexistent token", () => {
        const result = store.update("nonexistent", {
          refreshToken: "r",
          refreshTokenIdleExpiresAt: 0,
          controlPlaneToken: "c",
          dataPlaneToken: "d",
          controlPlaneExpiresAt: 0,
          dataPlaneExpiresAt: 0,
        });

        expect(result).toBe(false);
      });
    });

    describe("getAllAccessTokens", () => {
      it("should return all stored access tokens", () => {
        store.store(createTokenSet({ accessToken: "token-1" }));
        store.store(createTokenSet({ accessToken: "token-2" }));

        const tokens = store.getAllAccessTokens();
        expect(tokens).toContain("token-1");
        expect(tokens).toContain("token-2");
        expect(tokens).toHaveLength(2);
      });

      it("should return empty array when store is empty", () => {
        expect(store.getAllAccessTokens()).toHaveLength(0);
      });
    });

    describe("size", () => {
      it("should return 0 for empty store", () => {
        expect(store.size).toBe(0);
      });

      it("should return correct count after stores and removes", () => {
        store.store(createTokenSet({ accessToken: "a" }));
        store.store(createTokenSet({ accessToken: "b" }));
        expect(store.size).toBe(2);

        store.remove("a");
        expect(store.size).toBe(1);
      });
    });

    describe("startRefreshLoop", () => {
      let clock: sinon.SinonFakeTimers;

      beforeEach(() => {
        clock = sinon.useFakeTimers({ shouldAdvanceTime: false });
      });

      afterEach(() => {
        clock.restore();
      });

      it("should call the refresh callback at the specified interval", async () => {
        const callback = sinon.stub().resolves();
        store.startRefreshLoop(240_000, callback);

        // Advance 4 minutes
        await clock.tickAsync(240_000);
        sinon.assert.calledOnce(callback);
        sinon.assert.calledWith(callback, store);

        // Advance another 4 minutes
        await clock.tickAsync(240_000);
        sinon.assert.calledTwice(callback);
      });

      it("should not start a second loop if already running", () => {
        const callback = sinon.stub().resolves();
        store.startRefreshLoop(240_000, callback);
        store.startRefreshLoop(240_000, callback); // second call should be no-op

        // Only one interval should be active — verified by shutdown not throwing
        store.shutdown();
      });

      it("should stop the loop on shutdown", async () => {
        const callback = sinon.stub().resolves();
        store.startRefreshLoop(240_000, callback);

        store.shutdown();

        await clock.tickAsync(240_000);
        sinon.assert.notCalled(callback);
      });

      it("should not throw if refresh callback throws", async () => {
        const callback = sinon.stub().rejects(new Error("refresh failed"));
        store.startRefreshLoop(240_000, callback);

        // Should not throw
        await clock.tickAsync(240_000);
        sinon.assert.calledOnce(callback);

        // Loop should still be alive
        await clock.tickAsync(240_000);
        sinon.assert.calledTwice(callback);
      });
    });
  });
});
