import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StdioTransport } from "@src/mcp/transports/stdio.js";
import { createMockInstance } from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

describe("stdio.ts", () => {
  describe("StdioTransport", () => {
    describe("connect()", () => {
      it("should connect the McpServer over a fresh StdioServerTransport", async () => {
        const server = createMockInstance(McpServer);
        server.connect.mockResolvedValue(undefined);
        const transport = new StdioTransport(server);

        await transport.connect();

        expect(server.connect).toHaveBeenCalledOnce();
        expect(server.connect).toHaveBeenCalledWith(
          expect.any(StdioServerTransport),
        );
      });

      it("should propagate a rejection from the server connect", async () => {
        const server = createMockInstance(McpServer);
        server.connect.mockRejectedValue(new Error("connect refused"));
        const transport = new StdioTransport(server);

        await expect(transport.connect()).rejects.toThrow("connect refused");
      });
    });

    describe("disconnect()", () => {
      it("should resolve without touching the server (stdio has nothing to tear down)", async () => {
        const server = createMockInstance(McpServer);
        const transport = new StdioTransport(server);

        await expect(transport.disconnect()).resolves.toBeUndefined();

        expect(server.connect).not.toHaveBeenCalled();
      });
    });
  });
});
