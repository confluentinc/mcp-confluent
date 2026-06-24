import { TransportType } from "@src/mcp/transports/types.js";

/**
 * Resolves the set of transports active for the current test run from the
 * `INTEGRATION_TEST_TRANSPORT` env var:
 *
 * - unset → run every transport (local default; full coverage)
 * - one of {@linkcode TransportType} (case-insensitive) → run that transport
 *   only (CI per-block filter, or a dev iterating on one transport's
 *   behavior)
 *
 * Pass the resulting array directly to `describe.each(...)` so iterations
 * for excluded transports are never registered (vs. registered-then-skipped),
 * which matters because nested `beforeAll`s for those iterations would still
 * spawn servers and hit the CCloud latency tax for no reason.
 *
 * @throws if `INTEGRATION_TEST_TRANSPORT` is set but not a known transport name.
 */
function resolveActiveTransports(): TransportType[] {
  const known = Object.values(TransportType);
  const raw = process.env.INTEGRATION_TEST_TRANSPORT;
  if (!raw) {
    return known;
  }
  const filter = raw.toLowerCase() as TransportType;
  if (!known.includes(filter)) {
    throw new Error(
      `INTEGRATION_TEST_TRANSPORT must be one of ${known.join("|")}; got: ${raw}`,
    );
  }
  return [filter];
}

export const activeTransports: TransportType[] = resolveActiveTransports();

/**
 * Transports an OAuth describe should iterate: {@linkcode activeTransports}
 * narrowed to stdio only.
 *
 * The CCloud OAuth sign-in is transport-agnostic — the Auth0/PKCE flow drives a
 * browser regardless of MCP transport, and the resulting bearer token then rides
 * whatever transport the tool call uses. The stdio/http/sse transport layer is
 * already covered by the (parallel, fast) direct describes and the smoke suite,
 * so running the OAuth flow on all three transports just re-pays the
 * Auth0-round-trip tax thrice. Worse, every OAuth describe serializes on the
 * single hard-coded callback port (see {@linkcode acquireOAuthPortLock}), so
 * ×3 transports triples the serialized lock-holds and is what pushed the @kafka
 * job's queued `beforeAll`s past their 180s hook timeout. Pinning OAuth to one
 * transport cuts that contention ~3× at no real coverage loss.
 *
 * Honors `INTEGRATION_TEST_TRANSPORT`: when an operator forces a non-stdio
 * transport this is empty, so OAuth describes register nothing (consistent with
 * "OAuth is stdio-only" rather than silently running on the forced transport).
 */
export const activeOAuthTransports: TransportType[] = activeTransports.filter(
  (transport) => transport === TransportType.STDIO,
);
