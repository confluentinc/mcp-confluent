/**
 * Minimum Node.js major version the server supports. Kept in lockstep with the
 * `engines.node` field in package.json. The preflight shim (src/index.ts) reads
 * this to reject older runtimes with a clear message *before* any module
 * carrying modern syntax (e.g. the JSON import attribute in cli.ts) is parsed
 * and crashes with a cryptic SyntaxError.
 */
export const MINIMUM_NODE_MAJOR = 22;

/**
 * Return a human-readable error message when `currentVersion` is older than
 * `minimumMajor`, otherwise `undefined`.
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
  minimumMajor: number,
): string | undefined {
  const major = parseInt(currentVersion.replace(/^v/, ""), 10);
  if (Number.isNaN(major) || major < minimumMajor) {
    return (
      `mcp-confluent requires Node.js ${minimumMajor} or newer, ` +
      `but the current runtime is Node.js ${currentVersion}.\n` +
      `Please upgrade Node.js (https://nodejs.org/) and try again.`
    );
  }
  return undefined;
}
