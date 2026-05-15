import type { Transport as SdkTransport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { SessionRegistry } from "@src/mcp/transports/session-registry.js";
import { createMockInstance } from "@tests/stubs/mock-instance.js";
import type { Mocked } from "vitest";

/**
 * Creates a {@linkcode Mocked} {@link SessionRegistry} with every method pre-stubbed.
 * Async methods default to {@linkcode mockResolvedValue} so production code that awaits
 * (or chains `.catch`) on them works without per-test setup.
 */
export function createMockSessionRegistry<
  T extends SdkTransport = SdkTransport,
>(): Mocked<SessionRegistry<T>> {
  const mock = createMockInstance(SessionRegistry) as Mocked<
    SessionRegistry<T>
  >;
  mock.bindServer.mockResolvedValue();
  mock.closeAndRemove.mockResolvedValue();
  mock.closeAll.mockResolvedValue();
  return mock;
}
