import { type StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMockSdkTransport } from "@tests/stubs/sdk-transport.js";
import { type Mocked, vi } from "vitest";

/** Sentinel UUID for stubbed HTTP sessions; pair with any other UUID for "unknown" cases. */
export const MOCK_SESSION_ID = "11111111-1111-1111-1111-111111111111";

/**
 * Creates a {@linkcode Mocked} {@link StreamableHTTPServerTransport} stub. {@linkcode handleRequest}
 * writes a 200 to the raw response so {@linkcode fastify.inject} resolves; {@linkcode sessionId}
 * and {@linkcode onclose} land as plain data props (the SDK class declares them as accessors,
 * which {@linkcode createMockInstance} can't auto-stub).
 */
export function createMockHttpServerTransport(
  sessionId: string | undefined = MOCK_SESSION_ID,
): Mocked<StreamableHTTPServerTransport> {
  return {
    ...createMockSdkTransport(),
    handleRequest: vi.fn().mockImplementation((_req, res) => {
      res.statusCode = 200;
      res.end();
      return Promise.resolve();
    }),
    closeSSEStream: vi.fn(),
    closeStandaloneSSEStream: vi.fn(),
    sessionId,
    onclose: undefined,
  } as unknown as Mocked<StreamableHTTPServerTransport>;
}
