import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolHandler } from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { CreateMcpServerOptions } from "@src/mcp/server.js";
import { TransportManager } from "@src/mcp/transports/manager.js";
import { TransportType } from "@src/mcp/transports/types.js";
import { runtimeWith } from "@tests/factories/runtime.js";
import { beforeEach, describe, expect, it } from "vitest";

describe("TransportManager", () => {
  let manager: TransportManager;
  let serverOptions: CreateMcpServerOptions;

  beforeEach(() => {
    manager = new TransportManager();
    serverOptions = {
      serverVersion: "0.0.0-test",
      toolHandlers: new Map<ToolName, ToolHandler>(),
      runtime: runtimeWith(),
    };
  });

  describe("createTransport()", () => {
    it("should reuse the cached stdio McpServer across repeated createTransport calls", () => {
      // stdio is single-client by construction, so a `start() → stop() → start()` cycle should
      // hand the new StdioTransport the same cached McpServer until the manager's `stop()`
      // explicitly clears it
      manager["createTransport"](TransportType.STDIO, serverOptions, undefined);
      const cachedAfterFirst = manager["stdioServer"];

      manager["createTransport"](TransportType.STDIO, serverOptions, undefined);
      const cachedAfterSecond = manager["stdioServer"];

      expect(cachedAfterFirst).toBeInstanceOf(McpServer);
      expect(cachedAfterSecond).toBe(cachedAfterFirst);
    });
  });
});
