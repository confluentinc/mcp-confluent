/**
 * Minimum full Node.js version (major.minor.patch) the server supports. Kept in
 * lockstep with the `engines.node` field in package.json.
 *
 * A full version, not just a major, because the floor is dictated by a
 * transitive dependency: undici (via cheerio) declares `engines.node
 * >=22.19.0` and, at load time, destructures `markAsUncloneable` from
 * `node:worker_threads` — an export that only exists from Node 22.10.0 onward.
 * On an older 22.x (e.g. 22.0.0) undici crashes with a cryptic
 * `webidl.util.markAsUncloneable is not a function` deep in its cache module,
 * which is exactly the inscrutable-crash-instead-of-clear-message failure the
 * preflight shim (src/index.ts) exists to prevent (issue #455). A major-only
 * gate waved those runtimes straight into that crash, so the gate compares the
 * full version. Bump this in step with undici's `engines.node` floor.
 */
export const MINIMUM_NODE_VERSION = "22.19.0";

/**
 * Parse a `major.minor.patch` triple from a Node version string, tolerating a
 * leading "v" and an absent minor/patch (defaulted to 0). Returns `null` when
 * no leading major integer is present, so callers can treat an unidentifiable
 * runtime as unsupported.
 */
function parseVersion(version: string): [number, number, number] | null {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(
    version.replace(/^v/, ""),
  );
  if (match === null) {
    return null;
  }
  return [Number(match[1]), Number(match[2] || "0"), Number(match[3] || "0")];
}

/**
 * Report whether version `a` is strictly older than version `b`, comparing
 * major then minor then patch.
 */
function isOlder(
  a: [number, number, number],
  b: [number, number, number],
): boolean {
  if (a[0] !== b[0]) {
    return a[0] < b[0];
  }
  if (a[1] !== b[1]) {
    return a[1] < b[1];
  }
  return a[2] < b[2];
}

/**
 * Return a human-readable error message when `currentVersion` is older than
 * `minimumVersion`, otherwise `undefined`.
 *
 * Pure (no I/O) so the version gate is exhaustively unit-testable by passing
 * `process.versions.node`-shaped strings directly. A leading "v" is tolerated.
 * An unparseable version is treated as unsupported rather than waved through —
 * we would rather show the upgrade message than hand control to a runtime we
 * could not identify.
 *
 * Authored in syntax that parses on very old Node (no optional chaining, no
 * import attributes): this module sits in the shim's static import graph, so a
 * parse error here would reintroduce the very cryptic crash the shim exists to
 * prevent.
 */
export function nodeVersionError(
  currentVersion: string,
  minimumVersion: string,
): string | undefined {
  const current = parseVersion(currentVersion);
  const minimum = parseVersion(minimumVersion);
  if (current === null || minimum === null || isOlder(current, minimum)) {
    return (
      `mcp-confluent requires Node.js ${minimumVersion} or newer, ` +
      `but the current runtime is Node.js ${currentVersion}.\n` +
      `Please upgrade Node.js (https://nodejs.org/) and try again.`
    );
  }
  return undefined;
}
