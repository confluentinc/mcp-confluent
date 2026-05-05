import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport as SdkTransport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { logger } from "@src/logger.js";

/** Paired SDK transport + {@link McpServer} representing one MCP session. */
export interface SessionEntry<T extends SdkTransport = SdkTransport> {
  readonly transport: T;
  readonly server: McpServer;
}

/**
 * Registry of {@link SessionEntry} pairs keyed by MCP session id. Multi-client transports need
 * one {@link McpServer} per session because the SDK binds each server to a single transport.
 *
 * {@see https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/simpleStreamableHttp.ts}
 * {@see https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#session-management}
 */
export class SessionRegistry<T extends SdkTransport = SdkTransport> {
  private readonly sessions = new Map<string, SessionEntry<T>>();

  set(sessionId: string, entry: SessionEntry<T>): void {
    this.sessions.set(sessionId, entry);
  }

  get(sessionId: string): SessionEntry<T> | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Connects {@linkcode server} to {@linkcode transport}; closes both on rejection. The pair
   * is not in the registry yet at this point (the SDK's {@linkcode T.onsessioninitialized}
   * callback fires later, during {@linkcode T.handleRequest}), so failure here is an orphan
   * cleanup, not a registry mutation.
   */
  async bindServer(server: McpServer, transport: T): Promise<void> {
    try {
      await server.connect(transport);
    } catch (err) {
      await this.closeEntry({ transport, server });
      throw err;
    }
  }

  /** Closes the {@link SessionEntry} for {@linkcode sessionId} (if any) and removes it. */
  async closeAndRemove(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    // delete first so a re-entrant call from `transport.onclose` is a no-op
    this.sessions.delete(sessionId);
    await this.closeEntry(entry);
  }

  /** Closes every registered transport + server pair and clears the registry. */
  async closeAll(): Promise<void> {
    const entries = [...this.sessions.values()];
    this.sessions.clear();
    for (const entry of entries) {
      await this.closeEntry(entry);
    }
  }

  /** Closes both halves of {@linkcode entry}, logging (not propagating) any failures. */
  private async closeEntry(entry: SessionEntry<T>): Promise<void> {
    try {
      await entry.transport.close();
    } catch (err) {
      logger.error({ err }, "transport.close() failed during session cleanup");
    }
    try {
      await entry.server.close();
    } catch (err) {
      logger.error({ err }, "server.close() failed during session cleanup");
    }
  }
}
