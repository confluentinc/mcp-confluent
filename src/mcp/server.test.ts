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
    // registers all tools by default
    ctx = await createTestServer(
      sinon.createStubInstance(DefaultClientManager),
    );
  });

  afterEach(() => ctx.shutdown());

  it("should report server info after handshake", () => {
    const info = ctx.client.getServerVersion();

    expect(info?.name).toBeDefined();
    expect(info?.version).toBeDefined();
  });

  it("should register all tools via MCP protocol", async () => {
    const { tools } = await ctx.client.listTools();

    expect(tools).toHaveLength(ALL_TOOL_NAMES.length);
  });
});
