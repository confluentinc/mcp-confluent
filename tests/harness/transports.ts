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
