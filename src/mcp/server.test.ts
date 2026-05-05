import { ToolName } from "@src/confluent/tools/tool-name.js";
import { runtimeWith } from "@tests/factories/runtime.js";
import { createTestServer, TestServerContext } from "@tests/server.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ALL_TOOL_NAMES = Object.values(ToolName);

// covers protocol-level behavior that needs a connected client; pure registration shape lives
// in the unit suite next to src/mcp/server.ts
describe("MCP server", () => {
  let ctx: TestServerContext;

  beforeEach(async () => {
    // registers all tools by default
    ctx = await createTestServer(runtimeWith());
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
