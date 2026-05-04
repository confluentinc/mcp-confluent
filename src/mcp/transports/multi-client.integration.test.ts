import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TransportType } from "@src/mcp/transports/types.js";
import { integrationRuntime } from "@tests/harness/runtime.js";
import {
  startServer,
  type StartedServer,
} from "@tests/harness/start-server.js";
import { Tag } from "@tests/tags.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// transport-layer test (not tool-group), same fixture as the spawned server
const runtime = integrationRuntime();

describe("HTTP multi-client", { tags: [Tag.SMOKE] }, () => {
  if (Object.keys(runtime.config.connections).length === 0) {
    it.skip("requires at least one configured connection in integration.yaml", () => {});
    return;
  }

  let server: StartedServer;
  let secondClient: Client | undefined;

  beforeAll(async () => {
    server = await startServer({ transport: TransportType.HTTP });
  });

  afterAll(async () => {
    await secondClient?.close();
    await server?.stop();
  });

  it("should let a second client connect to an active server", async () => {
    // per-session McpServer wiring in HttpTransport is what makes the second handshake succeed
    // (pre-#116 this connect() throws "Already connected to a transport")
    secondClient = new Client({
      name: "mcp-confluent-multi-client-2",
      version: "0.0.0-test",
    });
    const secondTransport = new StreamableHTTPClientTransport(
      new URL(`${server.baseUrl}/mcp`),
    );

    await expect(
      secondClient.connect(secondTransport),
    ).resolves.toBeUndefined();

    // a fresh session id server-side = a distinct McpServer in SessionRegistry
    expect(secondTransport.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(secondTransport.sessionId).not.toEqual(
      server.client.transport!.sessionId,
    );

    // both sessions see the same tool set; equality matters, count doesn't
    const [firstTools, secondTools] = await Promise.all([
      server.client.listTools(),
      secondClient.listTools(),
    ]);

    const firstNames = firstTools.tools.map((t) => t.name).sort();
    const secondNames = secondTools.tools.map((t) => t.name).sort();
    expect(secondNames).toEqual(firstNames);
  });
});
