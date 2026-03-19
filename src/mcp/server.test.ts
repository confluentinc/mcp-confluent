import { DefaultClientManager } from "@src/confluent/client-manager.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { createTestServer, TestServerContext } from "@src/test-utils/server.js";
import sinon from "sinon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("MCP server startup", () => {
  let ctx: TestServerContext;

  // register a single lightweight tool to keep setup fast
  beforeEach(async () => {
    ctx = await createTestServer(
      sinon.createStubInstance(DefaultClientManager),
      [ToolName.LIST_TOPICS],
    );
  });

  afterEach(async () => {
    await ctx.client.close();
    await ctx.server.close();
  });

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
