import { TransportType } from "@src/mcp/transports/types.js";
import { integrationRuntime } from "@tests/harness/runtime.js";
import {
  startServer,
  type StartedServer,
} from "@tests/harness/start-server.js";
import { Tag } from "@tests/tags.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CFLT_MCP_API_KEY_HEADER } from "./auth.js";

// transport-layer test, not a tool-group test. gates on whether ANY runtime
// connection loaded (i.e., whether the YAML's required `${VAR}` interpolations
// succeeded), since the spawned server uses the same fixture: if it can't
// build a runtime, the spawn would fail too. while the fixture is currently
// kafka-only this resolves to "kafka creds present", but the gate stays
// correct as the fixture grows.
const runtime = integrationRuntime();

const TEST_API_KEY =
  "integration-auth-smoke-test-key-not-a-real-credential-do-not-reuse";

describe("HTTP auth middleware", { tags: [Tag.SMOKE] }, () => {
  if (Object.keys(runtime.config.connections).length === 0) {
    it.skip("requires at least one configured connection in integration.yaml", () => {});
    return;
  }

  let server: StartedServer;

  beforeAll(async () => {
    server = await startServer({
      transport: TransportType.HTTP,
      auth: { apiKey: TEST_API_KEY },
    });
  });

  afterAll(async () => {
    await server?.stop();
  });

  it(`should reject requests with no ${CFLT_MCP_API_KEY_HEADER} header with 401`, async () => {
    const response = await fetch(`${server.baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Unauthorized");
  });

  it(`should reject requests with the wrong ${CFLT_MCP_API_KEY_HEADER} with 401`, async () => {
    const response = await fetch(`${server.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [CFLT_MCP_API_KEY_HEADER]: "not-the-server-key",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Unauthorized");
  });

  it("should accept the SDK client roundtrip when the correct key is supplied", async () => {
    // beforeAll already connected the SDK client with the correct header via the
    // harness; a successful tools/list round-trip proves the same header reaches
    // the auth-protected /mcp endpoint and the middleware accepts it. the
    // returned tool count is irrelevant here (a future fixture may have a
    // connection with no service blocks and zero tools); only the resolved
    // promise matters.
    await expect(server.client.listTools()).resolves.toBeDefined();
  });
});
