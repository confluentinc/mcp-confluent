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
// mcp-confluent worktrees running OAuth tests on the same host.
const LOCK_PATH = join(tmpdir(), `mcp-oauth-port-26640-${cwdNamespace()}.lock`);

function cwdNamespace(): string {
  return createHash("sha256").update(process.cwd()).digest("hex").slice(0, 12);
}

const POLL_INTERVAL_MS = 500;

/**
 * Block until OAUTH_CALLBACK_PORT is free, then claim it by writing `process.pid` into the lock
 * file. Stale locks (holder PID no longer alive) are reclaimed automatically.
 */
export async function acquireOAuthPortLock(timeoutMs = 300_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (tryAcquire()) return;
    if (existsSync(LOCK_PATH) && !holderAlive()) {
      // ignore: a peer fork may unlink first; the next loop iteration retries cleanly
      try {
        unlinkSync(LOCK_PATH);
      } catch {
        // intentional
      }
      continue;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `OAuth port lock at ${LOCK_PATH} not released within ${timeoutMs}ms (holder PID=${holderPid() ?? "unknown"})`,
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
