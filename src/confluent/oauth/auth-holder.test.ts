import { AuthContext } from "@src/confluent/oauth/auth-context.js";
import { AuthHolder } from "@src/confluent/oauth/auth-holder.js";
import {
  getAuth0Config,
  OAUTH_CALLBACK_PATH,
} from "@src/confluent/oauth/auth0-config.js";
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

describe("oauth/auth-holder.ts", () => {
  let fetchSpy: MockedFetch;
  const auth0Config = getAuth0Config("devel");

  beforeEach(() => {
    fetchSpy = mockFetch();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("constructor", () => {
    it("should expose CP/DP tokens from the wrapped context", async () => {
      stubFullChain(fetchSpy);
      const ctx = await AuthContext.newFromInitialLogin(
        auth0Config,
        "code",
        "verifier",
      );

      const holder = makeHolder(ctx);

      expect(holder.getControlPlaneToken()).toBe("cp");
      expect(holder.getDataPlaneToken()).toBe("dp");
    });

    it("should return undefined tokens when there is no context", () => {
      const holder = makeHolder(undefined);
      expect(holder.getControlPlaneToken()).toBeUndefined();
      expect(holder.getDataPlaneToken()).toBeUndefined();
    });
  });

  describe("shutdown", () => {
    it("should clear the held context and stop its refresh loop", async () => {
      stubFullChain(fetchSpy);
      const ctx = await AuthContext.newFromInitialLogin(
        auth0Config,
        "code",
        "verifier",
      );
      const holder = makeHolder(ctx);
      ctx.startRefreshLoop(60_000);

      holder.shutdown();

      expect(holder.getControlPlaneToken()).toBeUndefined();
      expect(holder.getDataPlaneToken()).toBeUndefined();
    });

    it("should be safe to call when no context is held", () => {
      const holder = makeHolder(undefined);
      expect(() => holder.shutdown()).not.toThrow();
    });
  });

  describe("bootstrap", () => {
    it("should run PKCE end-to-end and return a holder serving the issued tokens", async () => {
      const httpMock = mockHttpServer();
      const openSpy = mockOpen();
      stubFullChain(fetchSpy);

      const bootstrapPromise = AuthHolder.bootstrap("devel");

      await httpMock.listening;
      // Flush microtasks so production code progresses past `await bindResult`
      // and `await nodeOpen.open()` before we drive the callback.
      await Promise.resolve();
      await Promise.resolve();
      const openedUrl = openSpy.mock.calls[0]![0];
      const state = new URL(openedUrl).searchParams.get("state")!;
      await httpMock.fireRequest(
        `${OAUTH_CALLBACK_PATH}?code=auth-code&state=${state}`,
      );

      const holder = await bootstrapPromise;
      try {
        expect(holder.getControlPlaneToken()).toBe("cp");
        expect(holder.getDataPlaneToken()).toBe("dp");
      } finally {
        holder.shutdown();
      }
    });
  });
});

function makeHolder(ctx: AuthContext | undefined): AuthHolder {
  type PrivateCtor = new (ctx: AuthContext | undefined) => AuthHolder;
  return new (AuthHolder as unknown as PrivateCtor)(ctx);
}
