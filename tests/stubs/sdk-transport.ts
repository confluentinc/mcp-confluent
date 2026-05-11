import type { Transport as SdkTransport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type Mocked, vi } from "vitest";

/** Sentinel UUID for stubbed transports; pair with any other UUID for "unknown" cases. */
export const MOCK_SESSION_ID = "11111111-1111-1111-1111-111111111111";

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

/**
 * Creates a session-aware mock transport: the base methods from {@linkcode createMockSdkTransport}
 * plus a {@linkcode sessionId} data prop (defaults to {@linkcode MOCK_SESSION_ID}) and a writable
 * {@linkcode onclose}, with caller-supplied {@linkcode extra} fields merged on top — typically
 * the transport's routing method (e.g. {@linkcode handleRequest}, {@linkcode handlePostMessage}).
 * The SDK declares {@linkcode sessionId} and {@linkcode onclose} as accessors on the concrete
 * transport classes, which {@linkcode createMockInstance} can't auto-stub; installing them as
 * data props here lets tests reassign them at runtime.
 */
export function createMockTransportWithSession<T extends SdkTransport>(
  extra: Partial<Mocked<T>>,
  sessionId: string | undefined = MOCK_SESSION_ID,
): Mocked<T> {
  return {
    ...createMockSdkTransport(),
    ...extra,
    sessionId,
    onclose: undefined,
  } as unknown as Mocked<T>;
}
