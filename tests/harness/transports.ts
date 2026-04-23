import type { Transport } from "@tests/harness/start-server.js";
export type { Transport } from "@tests/harness/start-server.js";

/** Canonical list of MCP transports exercised by integration tests. */
const ALL_TRANSPORTS: Transport[] = ["stdio", "http"];

/**
 * The set of transports active for the current test run, derived from the
 * `INTEGRATION_TEST_TRANSPORT` env var:
 *
 * - unset → run every transport (local default; full coverage)
 * - `stdio` or `http` → run that transport only (CI per-block filter, or
 *   a dev iterating on one transport's behavior)
 *
 * Pass this directly to `describe.each(...)` so iterations for excluded
 * transports are never registered (vs. registered-then-skipped), which
 * matters because nested `beforeAll`s for those iterations would still spawn
 * servers and hit the CCloud latency tax for no reason.
 *
 * @throws if `INTEGRATION_TEST_TRANSPORT` is set but not a known transport name.
 */
export const activeTransports: Transport[] = (() => {
  const filter = process.env.INTEGRATION_TEST_TRANSPORT;
  if (!filter) return ALL_TRANSPORTS;
  if (!ALL_TRANSPORTS.includes(filter as Transport)) {
    throw new Error(
      `INTEGRATION_TEST_TRANSPORT must be one of ${ALL_TRANSPORTS.join("|")}; got: ${filter}`,
    );
  }
  return [filter as Transport];
})();
