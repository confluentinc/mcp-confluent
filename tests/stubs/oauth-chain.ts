import type { UserDetails } from "@src/confluent/oauth/types.js";
import type { MockedFetch } from "@tests/stubs/node-deps.js";

/**
 * Build a `Response` carrying a JSON body. Convenience helper for the
 * Auth0 → CP → DP stub family below — every leg returns JSON.
 */
export function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Primes one Auth0 `/oauth/token` success response on the fetch spy. */
export function stubAuth0Ok(
  fetchSpy: MockedFetch,
  refreshToken = "refresh-token",
  idToken = "id-token",
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

/**
 * Primes one CCloud `/api/sessions` success response on the fetch spy. The
 * optional `user` object lands in the response body and is what
 * {@link executeFullTokenChain} reads to populate `ccloudUserId` /
 * `ccloudDomain` on telemetry events.
 */
export function stubCpOk(
  fetchSpy: MockedFetch,
  cpToken = "cp-token",
  user?: UserDetails,
): void {
  fetchSpy.mockResolvedValueOnce(
    jsonResponse({ token: cpToken, ...(user ? { user } : {}) }),
  );
}

/** Primes one CCloud `/api/access_tokens` success response on the fetch spy. */
export function stubDpOk(fetchSpy: MockedFetch, dpToken = "dp-token"): void {
  fetchSpy.mockResolvedValueOnce(jsonResponse({ token: dpToken }));
}

/**
 * Prime a full Auth0 → CP → DP success chain on the fetch spy. Pass a
 * partial override map to customize a specific leg (e.g. inject `user` into
 * the CP response, or use distinct tokens for a refresh-then-rotate test).
 *
 * @example
 * ```ts
 * stubSuccessfulChain(fetchSpy); // defaults: refresh-token / id-token / cp-token / dp-token
 * stubSuccessfulChain(fetchSpy, { cpToken: "cp-2", dpToken: "dp-2" });
 * stubSuccessfulChain(fetchSpy, { user: { resource_id: "u-1", email: "a@b.c" } });
 * ```
 */
export function stubSuccessfulChain(
  fetchSpy: MockedFetch,
  overrides: {
    refreshToken?: string;
    idToken?: string;
    cpToken?: string;
    dpToken?: string;
    user?: UserDetails;
  } = {},
): void {
  stubAuth0Ok(fetchSpy, overrides.refreshToken, overrides.idToken);
  stubCpOk(fetchSpy, overrides.cpToken, overrides.user);
  stubDpOk(fetchSpy, overrides.dpToken);
}
