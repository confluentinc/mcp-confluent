import { type StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMockTransportWithSession } from "@tests/stubs/sdk-transport.js";
import { type Mocked, vi } from "vitest";

/**
 * Creates a {@linkcode Mocked} {@link StreamableHTTPServerTransport} stub. {@linkcode handleRequest}
 * writes a 200 to the raw response so {@linkcode fastify.inject} resolves.
 */
export function createMockHttpServerTransport(
  sessionId?: string,
): Mocked<StreamableHTTPServerTransport> {
  return createMockTransportWithSession<StreamableHTTPServerTransport>(
    {
      handleRequest: vi.fn().mockImplementation((_req, res) => {
        res.statusCode = 200;
        res.end();
        return Promise.resolve();
      }),
      closeSSEStream: vi.fn(),
      closeStandaloneSSEStream: vi.fn(),
    } as Partial<Mocked<StreamableHTTPServerTransport>>,
    sessionId,
  );
}
