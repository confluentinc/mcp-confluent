#!/usr/bin/env node

/**
 * Preflight shim — the package's `bin` entry point.
 *
 * WHY THIS IS A SEPARATE FILE (and not just a check at the top of the real
 * entry, `server-main.ts`):
 *
 * The server's module graph uses syntax that newer Node parses but older Node
 * does not — most notably the JSON import attribute `import pkg from
 * "../package.json" with { type: "json" }` in cli.ts. In ESM, the *entire*
 * static import graph is parsed and instantiated before a single statement
 * runs. So on an unsupported old runtime, `server-main.ts` → `cli.ts` blows up
 * with a raw `SyntaxError` pointing at a line deep inside our dist output —
 * before any code of ours could run, and therefore before any version check
 * we placed inside the server could fire. That is exactly what issue #455
 * reported: `npx mcp-confluent` dumping an inscrutable parser stack trace
 * instead of "you need a newer Node".
 *
 * The only way to win this race is to make the FIRST module Node loads contain
 * nothing it can't parse, do the version check there, and reach the real
 * server only through a *dynamic* `import()` — which defers parsing of the
 * modern-syntax graph until after the gate has passed (or bailed with a clear
 * message). This file, and the `preflight.ts` it statically imports, are
 * deliberately written in syntax that parses back to very old Node so the
 * friendly error survives where the server graph cannot.
 *
 * If you're a new dev wondering why this indirection exists at all: it's the
 * difference between a user seeing "mcp-confluent requires Node.js 22 or
 * newer" and a user seeing a JSON-import-attribute parse error from a file
 * they've never heard of. Don't fold this back into server-main.ts. See issue
 * #455 for the original report.
 *
 * This protection depends on the build staying a transpile (tsc emits one .js
 * per .ts, preserving the dynamic-import boundary), NOT a bundle. A bundler
 * that inlined the server graph into this entry file would drag the
 * modern-syntax imports back into the first-parsed module and silently undo
 * everything above. If you ever add a bundling step, keep this shim (and
 * preflight.ts) out of it.
 */

import { MINIMUM_NODE_MAJOR, nodeVersionError } from "@src/preflight.js";

/**
 * Gate on the Node.js runtime version, then hand off to the real server entry.
 *
 * Returns early (after printing the upgrade message and calling `exit(1)`) on an
 * unsupported runtime; otherwise dynamically imports `server-main.ts`, which
 * starts the server as a side effect of its own module-load (`await main()`).
 * The dynamic import is load-bearing, not stylistic — it is what keeps the
 * modern-syntax server graph from being parsed on a runtime that can't parse it
 * (see the file-level comment above).
 *
 * `exit` and `loadAndRunServer` are injected (defaulting to the real primitives)
 * so the dispatch is unit-testable without spawning a subprocess or stubbing
 * `process.exit`. The callback both loads and runs the server because importing
 * `server-main.ts` triggers its top-level `await main()`.
 */
export async function bootstrap({
  currentVersion = process.versions.node,
  exit = (code: number): void => process.exit(code),
  loadAndRunServer = (): Promise<unknown> => import("@src/server-main.js"),
}: {
  currentVersion?: string;
  exit?: (code: number) => void;
  loadAndRunServer?: () => Promise<unknown>;
} = {}): Promise<void> {
  const versionError = nodeVersionError(currentVersion, MINIMUM_NODE_MAJOR);
  if (versionError) {
    // Whoops! User is on an old Node. Print the specific version issue message and exit(1).
    console.error(versionError);
    exit(1);
    return;
  }

  // All good — load and invoke the real server entry (the module-level await main() over in server-main.ts).
  await loadAndRunServer();
}

// Fire-and-forget with `void`, NOT `await bootstrap()`. Top-level await is
// itself modern syntax that older Node fails to *parse* — using it here would
// reintroduce the very parse-time crash this shim exists to prevent, defeating
// the whole point. A `void`-discarded promise keeps the module body
// syntactically ancient-safe; `bootstrap()` does its own awaiting internally,
// and once the real server is imported the process stays alive on the
// transports it starts.
if (process.env.NODE_ENV !== "test") {
  void bootstrap();
}
