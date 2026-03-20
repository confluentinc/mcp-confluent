import { DefaultClientManager } from "@src/confluent/client-manager.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { createTestServer, TestServerContext } from "@tests/server.js";
import sinon from "sinon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ALL_TOOL_NAMES = Object.values(ToolName);

// server wiring (McpServer + tool registration) lives inline in src/index.ts
// main() and isn't importable directly, so we use createTestServer() with an
// in-memory transport to test the server lifecycle and protocol handling
describe("MCP server", () => {
  let ctx: TestServerContext;

  beforeEach(async () => {
    // registers all tools by default; sub-describes that need a specific
    // subset can override with their own beforeEach, e.g.:
    //   ctx = await createTestServer(clientManager, [ToolName.LIST_TOPICS]);
    ctx = await createTestServer(
      sinon.createStubInstance(DefaultClientManager),
    );
  });

  afterEach(() => ctx.shutdown());

  describe("server lifecycle", () => {
    it("should complete the MCP handshake and report server info", () => {
      const info = ctx.client.getServerVersion();

      expect(info).toBeDefined();
      expect(info?.name).toBe("confluent-test");
      expect(info?.version).toBe("0.0.0-test");
    });

    it("should respond to ping", async () => {
      // ping() resolves with an empty object if the server is alive
      await expect(ctx.client.ping()).resolves.toBeDefined();
    });

    it("should report tools capability after handshake", () => {
      const caps = ctx.client.getServerCapabilities();

      expect(caps).toBeDefined();
      expect(caps?.tools).toBeDefined();
    });
  });

  describe("tool registration", () => {
    it("should list all registered tools via MCP protocol", async () => {
      const { tools } = await ctx.client.listTools();

      expect(tools).toHaveLength(ALL_TOOL_NAMES.length);
    });

    it("should have a non-empty description and input schema for every listed tool", async () => {
      const { tools } = await ctx.client.listTools();

      for (const tool of tools) {
        expect(tool.description?.length).toBeGreaterThan(0);
        expect(tool.inputSchema).toBeDefined();
      }
    });
  });
});
