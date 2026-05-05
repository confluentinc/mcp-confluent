import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  createMockSdkTransport,
  type MockedSdkTransport,
} from "@tests/stubs/sdk-transport.js";
import { type Mock, vi } from "vitest";

/**
 * Stub-shape for a {@link StreamableHTTPServerTransport}: extends {@link MockedSdkTransport}
 * with the HTTP-only surface ({@linkcode handleRequest}, {@linkcode sessionId}, {@linkcode onclose}).
 */
export interface MockedHttpServerTransport extends MockedSdkTransport {
  handleRequest: Mock;
  sessionId: string | undefined;
  onclose: (() => void) | undefined;
}

/** Sentinel UUID for stubbed HTTP sessions; pair with any other UUID for "unknown" cases. */
export const MOCK_SESSION_ID = "11111111-1111-1111-1111-111111111111";

/**
 * Creates a {@link MockedHttpServerTransport}. {@linkcode handleRequest} writes a 200 to the
 * raw response so {@linkcode fastify.inject} resolves; {@linkcode close} is a resolved no-op.
 */
export function createMockHttpServerTransport(
  sessionId: string | undefined = MOCK_SESSION_ID,
): MockedHttpServerTransport {
  return {
    ...createMockSdkTransport(),
    handleRequest: vi.fn().mockImplementation((_req, res) => {
      res.statusCode = 200;
      res.end();
      return Promise.resolve();
    }),
    sessionId,
    onclose: undefined,
  };
}
