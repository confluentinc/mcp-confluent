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
 * Resolves active connection types based on whether `INTEGRATION_TEST_CONNECTION_TYPE` is set.
 * If unset, both 'direct' and 'oauth' connection types will be used.
 * If set, must be a case-insensitive value of either 'direct' or 'oauth'.
 * @throws on unknown values.
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

/** Skip reason when `INTEGRATION_TEST_CONNECTION_TYPE` skips the `direct` block of a dual-connection test. */
export const CONNECTION_TYPE_DIRECT_FILTERED_REASON =
  "INTEGRATION_TEST_CONNECTION_TYPE doesn't include 'direct'";

/** Skip reason when `INTEGRATION_TEST_CONNECTION_TYPE` skips the `oauth` block of a dual-connection test. */
export const CONNECTION_TYPE_OAUTH_FILTERED_REASON =
  "INTEGRATION_TEST_CONNECTION_TYPE doesn't include 'oauth'";
