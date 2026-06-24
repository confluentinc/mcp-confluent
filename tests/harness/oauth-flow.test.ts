import { TransportType } from "@src/mcp/transports/types.js";
import { startOAuthServer } from "@tests/harness/oauth-flow.js";
import { describe, expect, it } from "vitest";

describe("startOAuthServer", () => {
  // OAuth is stdio-only (the flow is transport-agnostic and serializes on one
  // callback port). A non-stdio call means an OAuth describe wrongly iterated
  // activeTransports. The guard is the first statement in startOAuthServer, so
  // it rejects before acquiring the lock or spawning; we assert the message
  // here (a lock/spawn-boundary assertion would race oauth-port-lock.test.ts on
  // the shared callback-port lock).
  it.each([TransportType.HTTP, TransportType.SSE])(
    "should reject %s with the stdio-only error naming activeOAuthTransports",
    async (transport) => {
      await expect(startOAuthServer({ transport })).rejects.toThrow(
        /OAuth tests are stdio-only — iterate activeOAuthTransports/,
      );
    },
  );
});
