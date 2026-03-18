import { ToolFactory } from "@src/confluent/tools/tool-factory.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { createTestServer, TestServerContext } from "@src/test-utils/server.js";
import { createStubClientManager } from "@src/test-utils/stubs/index.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ALL_TOOL_NAMES = Object.values(ToolName);

describe("tool registration", () => {
  it("should have a handler registered for every ToolName enum value", () => {
    for (const name of ALL_TOOL_NAMES) {
      expect(() => ToolFactory.createToolHandler(name)).not.toThrow();
    }
  });

  it("should return valid ToolConfig for every registered tool", () => {
    for (const name of ALL_TOOL_NAMES) {
      const handler = ToolFactory.createToolHandler(name);
      const config = handler.getToolConfig();

      expect(config.name).toBe(name);
      expect(config.description.length).toBeGreaterThan(10);
      expect(config.inputSchema).toBeDefined();
    }
  });

  describe("via MCP protocol", () => {
    let ctx: TestServerContext;

    beforeEach(async () => {
      ctx = await createTestServer(createStubClientManager());
    });

    afterEach(async () => {
      await ctx.client.close();
      await ctx.server.close();
    });

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
