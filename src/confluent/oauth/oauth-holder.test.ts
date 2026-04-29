import { AuthContext } from "@src/confluent/oauth/auth-context.js";
import {
  getAuth0Config,
  OAUTH_CALLBACK_PATH,
} from "@src/confluent/oauth/auth0-config.js";
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

      const bootstrapPromise = OAuthHolder.bootstrap("devel");

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

  describe("start", () => {
    it("should return a holder synchronously in the bootstrapping state with undefined tokens", () => {
      mockHttpServer();
      mockOpen();
      stubFullChain(fetchSpy);

      const holder = OAuthHolder.start("devel");
      try {
        expect(holder.getControlPlaneToken()).toBeUndefined();
        expect(holder.getDataPlaneToken()).toBeUndefined();
      } finally {
        holder.shutdown();
      }
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
    });

    it("should not start a refresh loop when shutdown happens before bootstrap settles", async () => {
      const httpMock = mockHttpServer();
      const openSpy = mockOpen();
      stubFullChain(fetchSpy);

      const holder = OAuthHolder.start("devel");
      await httpMock.listening;
      await Promise.resolve();
      await Promise.resolve();

      holder.shutdown();

      const openedUrl = openSpy.mock.calls[0]![0];
      const state = new URL(openedUrl).searchParams.get("state")!;
      await httpMock.fireRequest(
        `${OAUTH_CALLBACK_PATH}?code=auth-code&state=${state}`,
      );
      await holder.bootstrapPromise;

      expect(holder.getControlPlaneToken()).toBeUndefined();
      expect(holder.getDataPlaneToken()).toBeUndefined();
    });
  });
});

function makeHolder(ctx: AuthContext | undefined): OAuthHolder {
  type PrivateCtor = new (ctx: AuthContext | undefined) => OAuthHolder;
  return new (OAuthHolder as unknown as PrivateCtor)(ctx);
}
