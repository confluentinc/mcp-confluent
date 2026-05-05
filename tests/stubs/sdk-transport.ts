import type { Transport as SdkTransport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type Mocked, vi } from "vitest";

/** {@link SdkTransport} where each method is replaced with a {@linkcode vi.fn}. */
export type MockedSdkTransport = Mocked<SdkTransport>;

/** Creates a {@link MockedSdkTransport}. */
export function createMockSdkTransport(): MockedSdkTransport {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } as Mocked<SdkTransport>;
}
