import { AuthContext } from "@src/confluent/oauth/auth-context.js";
import { AuthHolder } from "@src/confluent/oauth/auth-holder.js";
import {
  getAuth0Config,
  OAUTH_CALLBACK_PATH,
} from "@src/confluent/oauth/auth0-config.js";
import type { Auth0Config } from "@src/confluent/oauth/types.js";
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

function stubFullChain(fetchSpy: MockedFetch, suffix = ""): void {
  fetchSpy.mockResolvedValueOnce(
    jsonResponse({
      id_token: `id${suffix}`,
      refresh_token: `refresh${suffix}`,
      access_token: `access${suffix}`,
      token_type: "Bearer",
      expires_in: 60,
    }),
  );
  fetchSpy.mockResolvedValueOnce(jsonResponse({ token: `cp${suffix}` }));
  fetchSpy.mockResolvedValueOnce(jsonResponse({ token: `dp${suffix}` }));
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

  describe("constructor / fromContext", () => {
    it("should expose CP/DP tokens from the wrapped context", async () => {
      stubFullChain(fetchSpy);
      const ctx = await AuthContext.newFromInitialLogin(
        auth0Config,
        "code",
        "verifier",
      );

      const holder = makeHolder(auth0Config, ctx);

      expect(holder.getControlPlaneToken()).toBe("cp");
      expect(holder.getDataPlaneToken()).toBe("dp");
    });

    it("should return undefined tokens when there is no context", () => {
      const holder = makeHolder(auth0Config, undefined);
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
      const holder = makeHolder(auth0Config, ctx);
      ctx.startRefreshLoop(60_000);

      holder.shutdown();

      expect(holder.getControlPlaneToken()).toBeUndefined();
      expect(holder.getDataPlaneToken()).toBeUndefined();
    });

    it("should be safe to call when no context is held", () => {
      const holder = makeHolder(auth0Config, undefined);
      expect(() => holder.shutdown()).not.toThrow();
    });
  });

  describe("hasNonTransientError", () => {
    it("should be false on a fresh login", async () => {
      stubFullChain(fetchSpy);
      const ctx = await AuthContext.newFromInitialLogin(
        auth0Config,
        "code",
        "verifier",
      );
      const holder = makeHolder(auth0Config, ctx);
      expect(holder.hasNonTransientError()).toBe(false);
    });

    it("should be true once the wrapped context records a non-transient error", async () => {
      stubFullChain(fetchSpy);
      const ctx = await AuthContext.newFromInitialLogin(
        auth0Config,
        "code",
        "verifier",
      );
      // Force the context into a non-transient state by directly mutating the
      // private errors field. Production code reaches this state via repeated
      // refresh failures; for this unit we assert the holder mirrors it.
      (
        ctx as unknown as {
          errors: { tokenRefresh?: { isTransient: boolean } };
        }
      ).errors = {
        tokenRefresh: { isTransient: false } as never,
      };

      const holder = makeHolder(auth0Config, ctx);
      expect(holder.hasNonTransientError()).toBe(true);
    });
  });

  describe("recoverIfBroken", () => {
    it("should return immediately when tokens are still good", async () => {
      stubFullChain(fetchSpy);
      const ctx = await AuthContext.newFromInitialLogin(
        auth0Config,
        "code",
        "verifier",
      );
      const holder = makeHolder(auth0Config, ctx);

      await holder.recoverIfBroken();

      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(holder.getControlPlaneToken()).toBe("cp");
    });

    it("should single-flight: two concurrent recoverIfBroken calls share one PKCE flow", async () => {
      // Initial chain (login that gets us into a broken state).
      stubFullChain(fetchSpy);
      const ctx = await AuthContext.newFromInitialLogin(
        auth0Config,
        "code",
        "verifier",
      );
      // Force the held context into a non-transient broken state — both
      // CP and DP tokens become unreadable, recoverIfBroken's fast-path skipped.
      (ctx as unknown as { cleared: boolean }).cleared = true;
      (
        ctx as unknown as { errors: { tokenRefresh: { isTransient: boolean } } }
      ).errors = { tokenRefresh: { isTransient: false } as never };
      const holder = makeHolder(auth0Config, ctx);

      // Stub the PKCE flow's I/O so recoverIfBroken's runPkceLogin can complete.
      const httpMock: MockedHttpServer = mockHttpServer();
      const openSpy: MockedOpen = mockOpen();
      // Recovery's full chain (auth0 + cp + dp).
      stubFullChain(fetchSpy, "-recovered");

      // Kick off two concurrent recoveries.
      const a = holder.recoverIfBroken();
      const b = holder.recoverIfBroken();

      // Wait for the production code to bind the listener and open the browser.
      await httpMock.listening;
      // Single-flight: only ONE browser open across both callers.
      expect(openSpy).toHaveBeenCalledTimes(1);

      // Drive the PKCE callback so runPkceLogin can complete.
      const openedUrl = openSpy.mock.calls[0]![0] as string;
      const state = new URL(openedUrl).searchParams.get("state")!;
      await httpMock.fireRequest(
        `${OAUTH_CALLBACK_PATH}?code=auth-code-recovered&state=${state}`,
      );

      await Promise.all([a, b]);

      // Recovery installed a fresh context with the new tokens.
      expect(holder.getControlPlaneToken()).toBe("cp-recovered");
      // Exactly one PKCE flow ran end-to-end.
      expect(httpMock.spy).toHaveBeenCalledTimes(1);
    });
  });
});

// AuthHolder's constructor is `private` (matching AuthContext's pattern).
// Tests construct via a typed cast — same approach `auth-context.test.ts` uses
// for reaching private state.
function makeHolder(
  auth0Config: Auth0Config,
  ctx: AuthContext | undefined,
): AuthHolder {
  type PrivateCtor = new (
    auth0Config: Auth0Config,
    ctx: AuthContext | undefined,
  ) => AuthHolder;
  return new (AuthHolder as unknown as PrivateCtor)(auth0Config, ctx);
}
