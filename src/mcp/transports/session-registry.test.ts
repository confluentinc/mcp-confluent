import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SessionRegistry } from "@src/mcp/transports/session-registry.js";
import {
  createMockInstance,
  createMockSdkTransport,
} from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

describe("session-registry.ts", () => {
  describe("SessionRegistry", () => {
    describe("closeAndRemove()", () => {
      it("should close transport and server then remove the entry for a known session id", async () => {
        const registry = new SessionRegistry();
        const transport = createMockSdkTransport();
        const server = createMockInstance(McpServer);
        registry.set("session-1", { transport, server });

        await registry.closeAndRemove("session-1");

        expect(transport.close).toHaveBeenCalledOnce();
        expect(server.close).toHaveBeenCalledOnce();
        // a follow-up call is a no-op once the entry is gone
        await registry.closeAndRemove("session-1");
        expect(transport.close).toHaveBeenCalledOnce();
        expect(server.close).toHaveBeenCalledOnce();
      });

      it("should be a no-op for an unknown session id", async () => {
        const registry = new SessionRegistry();
        const transport = createMockSdkTransport();
        const server = createMockInstance(McpServer);
        registry.set("session-1", { transport, server });

        await registry.closeAndRemove("session-unknown");

        expect(transport.close).not.toHaveBeenCalled();
        expect(server.close).not.toHaveBeenCalled();
      });

      it("should still close the server even when transport.close() rejects", async () => {
        const registry = new SessionRegistry();
        const transport = createMockSdkTransport();
        transport.close.mockRejectedValueOnce(new Error("transport boom"));
        const server = createMockInstance(McpServer);
        registry.set("session-1", { transport, server });

        await expect(
          registry.closeAndRemove("session-1"),
        ).resolves.toBeUndefined();

        expect(transport.close).toHaveBeenCalledOnce();
        expect(server.close).toHaveBeenCalledOnce();
      });
    });

    describe("closeAll()", () => {
      it("should close every registered transport + server pair and clear the registry", async () => {
        const registry = new SessionRegistry();
        const a = {
          transport: createMockSdkTransport(),
          server: createMockInstance(McpServer),
        };
        const b = {
          transport: createMockSdkTransport(),
          server: createMockInstance(McpServer),
        };
        registry.set("a", a);
        registry.set("b", b);

        await registry.closeAll();

        expect(a.transport.close).toHaveBeenCalledOnce();
        expect(a.server.close).toHaveBeenCalledOnce();
        expect(b.transport.close).toHaveBeenCalledOnce();
        expect(b.server.close).toHaveBeenCalledOnce();
        // a subsequent closeAll is a no-op (proves the registry was cleared)
        await registry.closeAll();
        expect(a.server.close).toHaveBeenCalledOnce();
        expect(b.server.close).toHaveBeenCalledOnce();
      });

      it("should keep closing remaining entries when one entry's close rejects", async () => {
        const registry = new SessionRegistry();
        const a = {
          transport: createMockSdkTransport(),
          server: createMockInstance(McpServer),
        };
        a.transport.close.mockRejectedValueOnce(new Error("transport boom"));
        const b = {
          transport: createMockSdkTransport(),
          server: createMockInstance(McpServer),
        };
        registry.set("a", a);
        registry.set("b", b);

        await expect(registry.closeAll()).resolves.toBeUndefined();

        expect(a.server.close).toHaveBeenCalledOnce();
        expect(b.transport.close).toHaveBeenCalledOnce();
        expect(b.server.close).toHaveBeenCalledOnce();
      });
    });

    describe("get()", () => {
      it("should return the registered entry for a known session id", () => {
        const registry = new SessionRegistry();
        const entry = {
          transport: createMockSdkTransport(),
          server: createMockInstance(McpServer),
        };
        registry.set("session-1", entry);

        expect(registry.get("session-1")).toBe(entry);
      });

      it("should return undefined for an unknown session id", () => {
        const registry = new SessionRegistry();

        expect(registry.get("session-unknown")).toBeUndefined();
      });
    });

    describe("bindServer()", () => {
      it("should resolve when connect() succeeds without closing the server", async () => {
        const registry = new SessionRegistry();
        const server = createMockInstance(McpServer);
        const transport = createMockSdkTransport();
        server.connect.mockResolvedValueOnce(undefined);

        await registry.bindServer(server, transport);

        expect(server.connect).toHaveBeenCalledOnce();
        expect(server.close).not.toHaveBeenCalled();
        expect(transport.close).not.toHaveBeenCalled();
      });

      it("should close both server and transport and rethrow when connect() rejects", async () => {
        const registry = new SessionRegistry();
        const server = createMockInstance(McpServer);
        const transport = createMockSdkTransport();
        const failure = new Error("handshake failed");
        server.connect.mockRejectedValueOnce(failure);

        await expect(registry.bindServer(server, transport)).rejects.toBe(
          failure,
        );

        expect(server.close).toHaveBeenCalledOnce();
        expect(transport.close).toHaveBeenCalledOnce();
      });
    });
  });
});
