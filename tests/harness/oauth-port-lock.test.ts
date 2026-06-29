import {
  acquireOAuthPortLock,
  LOCK_PATH,
  releaseOAuthPortLock,
} from "@tests/harness/oauth-port-lock.js";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** A PID that has definitely exited, so it reads as a dead/stale holder. */
function deadPid(): number {
  const { pid } = spawnSync(process.execPath, ["-e", ""]);
  if (pid === undefined) {
    throw new Error("could not spawn a throwaway process to obtain a dead pid");
  }
  return pid;
}

function clearLock(): void {
  if (existsSync(LOCK_PATH)) unlinkSync(LOCK_PATH);
}

describe("acquireOAuthPortLock", () => {
  beforeEach(clearLock);
  afterEach(() => {
    releaseOAuthPortLock();
    clearLock();
  });

  it("should claim a free lock, writing its own pid", () => {
    acquireOAuthPortLock();
    expect(Number(readFileSync(LOCK_PATH, "utf-8"))).toBe(process.pid);
  });

  // The load-bearing new behavior: a live foreign holder means OAuth tests are
  // running concurrently (broken setup), so balk immediately instead of queueing.
  it("should balk, naming the live holder, when another live process holds the lock", () => {
    writeFileSync(LOCK_PATH, String(process.ppid)); // a live pid that isn't ours
    expect(() => acquireOAuthPortLock()).toThrow(
      new RegExp(`held by a live process \\(PID=${process.ppid}\\)`),
    );
    expect(() => acquireOAuthPortLock()).toThrow(/--no-file-parallelism/);
    // a live holder's lock is left intact — we never steal it
    expect(Number(readFileSync(LOCK_PATH, "utf-8"))).toBe(process.ppid);
  });

  // A live-but-unsignalable holder (EPERM from process.kill, not ESRCH) must
  // count as alive so we don't unlink its lock. PID 1 (init/launchd) is always
  // alive and unsignalable by a non-root user, so it exercises the EPERM path.
  it("should treat a live-but-unsignalable holder (pid 1) as alive and balk", () => {
    writeFileSync(LOCK_PATH, "1");
    expect(() => acquireOAuthPortLock()).toThrow(/held by a live process/);
    expect(Number(readFileSync(LOCK_PATH, "utf-8"))).toBe(1); // not reclaimed
  });

  it("should reclaim a stale lock held by a dead pid and then acquire", () => {
    writeFileSync(LOCK_PATH, String(deadPid()));
    acquireOAuthPortLock();
    expect(Number(readFileSync(LOCK_PATH, "utf-8"))).toBe(process.pid);
  });
});
