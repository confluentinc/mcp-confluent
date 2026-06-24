import { TransportType } from "@src/mcp/transports/types.js";
import { startOAuthServer } from "@tests/harness/oauth-flow.js";
import { describe, expect, it } from "vitest";

describe("startOAuthServer", () => {
  // OAuth is stdio-only (the flow is transport-agnostic and serializes on one
  // callback port). A non-stdio call means an OAuth describe wrongly iterated
  // activeTransports; balk before acquiring the lock or spawning a server.
  it.each([TransportType.HTTP, TransportType.SSE])(
    "should reject %s before any side effect (OAuth is stdio-only)",
    async (transport) => {
      await expect(startOAuthServer({ transport })).rejects.toThrow(
        /OAuth tests are stdio-only — iterate activeOAuthTransports/,
      );
    },
  );
});
