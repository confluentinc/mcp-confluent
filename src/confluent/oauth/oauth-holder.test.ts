import { AuthContext } from "@src/confluent/oauth/auth-context.js";
import { OAUTH_CALLBACK_PATH } from "@src/confluent/oauth/auth0-config.js";
import { OAuthHolder } from "@src/confluent/oauth/oauth-holder.js";
import {
  mockFetch,
  mockHttpServer,
  mockOpen,
  type MockedFetch,
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

describe("oauth/oauth-holder.ts", () => {
  let fetchSpy: MockedFetch;

  beforeEach(() => {
    fetchSpy = mockFetch();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("start", () => {
    it("should return a holder synchronously in the bootstrapping state with undefined tokens", async () => {
      mockHttpServer();
      mockOpen();
      stubFullChain(fetchSpy);

      const holder = OAuthHolder.start("devel");
      // Sync observables, asserted before any await so the bootstrap is still in flight.
      expect(holder.getControlPlaneToken()).toBeUndefined();
      expect(holder.getDataPlaneToken()).toBeUndefined();

      // shutdown() aborts the in-flight PKCE via AbortSignal; bootstrap settles
      // promptly without waiting for the 120s PKCE timeout.
      holder.shutdown();
      await holder.bootstrapPromise;
    });

    it("should expose tokens after a successful bootstrap settles", async () => {
      const httpMock = mockHttpServer();
      const openSpy = mockOpen();
      stubFullChain(fetchSpy);

      const holder = OAuthHolder.start("devel");
      try {
        await httpMock.listening;
        await Promise.resolve();
        await Promise.resolve();
        const openedUrl = openSpy.mock.calls[0]![0];
        const state = new URL(openedUrl).searchParams.get("state")!;
        await httpMock.fireRequest(
          `${OAUTH_CALLBACK_PATH}?code=auth-code&state=${state}`,
        );
        await holder.bootstrapPromise;

        expect(holder.getControlPlaneToken()).toBe("cp");
        expect(holder.getDataPlaneToken()).toBe("dp");
      } finally {
        holder.shutdown();
      }
    });

    it("should leave tokens undefined and resolve (not reject) when bootstrap fails", async () => {
      mockHttpServer();
      const openSpy = mockOpen();
      openSpy.mockRejectedValueOnce(new Error("browser-open-failed"));
      stubFullChain(fetchSpy);

      const holder = OAuthHolder.start("devel");
      try {
        await expect(holder.bootstrapPromise).resolves.toBeUndefined();
        expect(holder.getControlPlaneToken()).toBeUndefined();
        expect(holder.getDataPlaneToken()).toBeUndefined();
      } finally {
        holder.shutdown();
      }
    });

    it("should be safe to call shutdown twice", async () => {
      const httpMock = mockHttpServer();
      const openSpy = mockOpen();
      stubFullChain(fetchSpy);

      const holder = OAuthHolder.start("devel");
      try {
        await httpMock.listening;
        await Promise.resolve();
        await Promise.resolve();
        const openedUrl = openSpy.mock.calls[0]![0];
        const state = new URL(openedUrl).searchParams.get("state")!;
        await httpMock.fireRequest(
          `${OAUTH_CALLBACK_PATH}?code=auth-code&state=${state}`,
        );
        await holder.bootstrapPromise;

        expect(() => {
          holder.shutdown();
          holder.shutdown();
        }).not.toThrow();
        expect(holder.getControlPlaneToken()).toBeUndefined();
      } finally {
        holder.shutdown();
      }
    });

    it("should not start a refresh loop when shutdown happens before bootstrap settles", async () => {
      mockHttpServer();
      mockOpen();
      stubFullChain(fetchSpy);
      const startRefreshLoopSpy = vi.spyOn(
        AuthContext.prototype,
        "startRefreshLoop",
      );

      const holder = OAuthHolder.start("devel");
      holder.shutdown();
      await holder.bootstrapPromise;

      expect(startRefreshLoopSpy).not.toHaveBeenCalled();
      expect(holder.getControlPlaneToken()).toBeUndefined();
      expect(holder.getDataPlaneToken()).toBeUndefined();
    });
  });
});
