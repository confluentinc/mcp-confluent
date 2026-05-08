import { type SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createMockTransportWithSession } from "@tests/stubs/sdk-transport.js";
import { type Mocked, vi } from "vitest";

/**
 * Creates a {@linkcode Mocked} {@link SSEServerTransport} stub. {@linkcode handlePostMessage}
 * writes a 200 to the raw response so {@linkcode fastify.inject} resolves.
 */
export function createMockSseServerTransport(
  sessionId?: string,
): Mocked<SSEServerTransport> {
  return createMockTransportWithSession<SSEServerTransport>(
    {
      handlePostMessage: vi.fn().mockImplementation((_req, res) => {
        res.statusCode = 200;
        res.end();
        return Promise.resolve();
      }),
    } as Partial<Mocked<SSEServerTransport>>,
    sessionId,
  );
}
