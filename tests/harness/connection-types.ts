/**
 * Connection-type analogue of `transports.ts`. Tests that support both
 * direct and OAuth connection shapes iterate `activeConnectionTypes` to
 * spawn one describe per supported mode, then iterate `activeTransports`
 * inside that for the transport axis.
 */
export enum ConnectionType {
  DIRECT = "direct",
  OAUTH = "oauth",
}

/**
 * Resolves the set of connection types active for the current test run
 * from the `INTEGRATION_TEST_CONNECTION_TYPE` env var:
 *
 * - unset → run every connection type (local default; full coverage)
 * - one of {@linkcode ConnectionType} (case-insensitive) → run only that
 *   connection type (CI per-block filter, or a dev iterating on one
 *   connection's behavior)
 *
 * Use the resulting array as the source for the outer iteration on
 * dual-mode tests. Iterations for excluded connection types are never
 * registered, so nested `beforeAll`s for those iterations don't run.
 *
 * @throws if `INTEGRATION_TEST_CONNECTION_TYPE` is set but not a known
 * connection type name.
 */
function resolveActiveConnectionTypes(): ConnectionType[] {
  const known = Object.values(ConnectionType);
  const raw = process.env.INTEGRATION_TEST_CONNECTION_TYPE;
  if (!raw) {
    return known;
  }
  const filter = raw.toLowerCase() as ConnectionType;
  if (!known.includes(filter)) {
    throw new Error(
      `INTEGRATION_TEST_CONNECTION_TYPE must be one of ${known.join("|")}; got: ${raw}`,
    );
  }
  return [filter];
}

export const activeConnectionTypes: ConnectionType[] =
  resolveActiveConnectionTypes();
