import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TransportType } from "@src/mcp/transports/types.js";
import { integrationRuntime } from "@tests/harness/runtime.js";
import {
  startServer,
  type StartedServer,
} from "@tests/harness/start-server.js";
import { activeTransports } from "@tests/harness/transports.js";
import { Tag } from "@tests/tags.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// transport-layer test (not tool-group), same fixture as the spawned server
const runtime = integrationRuntime();

// stdio is single-client by construction (one process, one stdin/stdout pair); only HTTP and SSE
// share a Fastify port across sessions, so multi-client coverage is restricted to those two
const multiClientTransports = activeTransports.filter(
  (t) => t === TransportType.HTTP || t === TransportType.SSE,
);

describe("multi-client", { tags: [Tag.SMOKE] }, () => {
  if (Object.keys(runtime.config.connections).length === 0) {
    it.skip("requires at least one configured connection in integration.yaml", () => {});
    return;
  }

  if (multiClientTransports.length === 0) {
    it.skip("multi-client coverage applies only to HTTP/SSE transports", () => {});
    return;
  }

  describe.each(multiClientTransports)("via %s transport", (transport) => {
    let server: StartedServer;
    let secondClient: Client | undefined;

    beforeAll(async () => {
      server = await startServer({ transport });
    });

    afterAll(async () => {
      await secondClient?.close();
      await server?.stop();
    });

    it("should let a second client connect to an active server", async () => {
      // per-session McpServer wiring (HttpTransport + SseTransport) is what makes the second
      // handshake succeed — a single shared server would throw "Already connected to a transport"
      secondClient = new Client({
        name: "mcp-confluent-multi-client-2",
        version: "0.0.0-test",
      });
      const secondTransport =
        transport === TransportType.HTTP
          ? new StreamableHTTPClientTransport(new URL(`${server.baseUrl}/mcp`))
          : new SSEClientTransport(new URL(`${server.baseUrl}/sse`));

      await expect(
        secondClient.connect(secondTransport),
      ).resolves.toBeUndefined();

      // HTTP exposes sessionId publicly; SSE doesn't (the session is embedded in the SDK
      // transport's private messaging URL). Guard the distinctness check on HTTP only.
      if (
        secondTransport instanceof StreamableHTTPClientTransport &&
        server.client.transport instanceof StreamableHTTPClientTransport
      ) {
        expect(secondTransport.sessionId).toMatch(/^[0-9a-f-]{36}$/);
        expect(secondTransport.sessionId).not.toEqual(
          server.client.transport.sessionId,
        );
      }

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
});
