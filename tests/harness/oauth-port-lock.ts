// Cross-process serialization for tests whose spawned MCP server binds OAUTH_CALLBACK_PORT
// (26640) during the CCloud OAuth flow. vitest's `pool: "forks"` puts each test file in its own process, so the
// filesystem is the only shared coordination point between forks. The lock content is the
// holder's PID so a crashed test (whose afterAll never runs) can be detected and stolen.

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `os.tmpdir()` works regardless of whether `node_modules` exists or is
// writable. The cwd-hash namespace prevents collisions between multiple
// mcp-confluent worktrees running OAuth tests on the same host. Exported so the
// colocated unit test can plant/inspect the lock file.
export const LOCK_PATH = join(
  tmpdir(),
  `mcp-oauth-port-26640-${cwdNamespace()}.lock`,
);

function cwdNamespace(): string {
  return createHash("sha256").update(process.cwd()).digest("hex").slice(0, 12);
}

/**
 * Claim OAUTH_CALLBACK_PORT by writing `process.pid` into the lock file, or balk loudly.
 *
 * OAuth integration tests **must run sequentially** — they all bind the one hard-coded callback
 * port — so under correct setup (`--no-file-parallelism`, see the OAuth lane in the Makefile /
 * `.semaphore`) the lock is always free when a file's `beforeAll` reaches here. Therefore:
 *
 * - **Free** → claim it.
 * - **Held by a live foreign process** → another OAuth test is running concurrently. That can only
 *   happen if the OAuth lane is (mis)configured to run in parallel — a broken setup — so we throw
 *   immediately and name the holder rather than queueing on it (the old behavior, which merely hid
 *   the misconfiguration behind a slow serialize-or-timeout).
 * - **Held by a dead PID** → a prior run crashed before `afterAll` released it; reclaim and take it.
 *
 * Synchronous: with no queueing left there is nothing to await.
 */
export function acquireOAuthPortLock(): void {
  if (tryAcquire()) return;

  if (holderAlive()) {
    throw new Error(
      `OAuth callback-port lock at ${LOCK_PATH} is held by a live process (PID=${holderPid()}). ` +
        `OAuth integration tests must run sequentially — a concurrent OAuth test session is a ` +
        `broken setup. Run the OAuth lane with --no-file-parallelism (the Makefile adds it when ` +
        `INTEGRATION_TEST_CONNECTION_TYPE=oauth).`,
    );
  }

  // Stale lock: the holder PID is gone (a prior run crashed before releasing). Reclaim it.
  try {
    unlinkSync(LOCK_PATH);
  } catch {
    // a peer may have unlinked first; fall through to the retry
  }
  if (tryAcquire()) return;
  throw new Error(
    `Failed to acquire OAuth callback-port lock at ${LOCK_PATH} after reclaiming a stale lock ` +
      `(holder PID=${holderPid() ?? "unknown"}).`,
  );
}

/** Release the lock if held by the current process. Safe to call when the lock is absent. */
export function releaseOAuthPortLock(): void {
  if (!existsSync(LOCK_PATH)) return;
  if (holderPid() === process.pid) {
    unlinkSync(LOCK_PATH);
  }
}

function tryAcquire(): boolean {
  try {
    const fd = openSync(LOCK_PATH, "wx");
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

function holderPid(): number | undefined {
  try {
    const pid = Number(readFileSync(LOCK_PATH, "utf-8").trim());
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function holderAlive(): boolean {
  const pid = holderPid();
  if (pid === undefined) return false;
  try {
    // signal 0 probes existence without delivering a signal; throws ESRCH if the pid is gone
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
