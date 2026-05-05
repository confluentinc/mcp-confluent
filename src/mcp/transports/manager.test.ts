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

  describe("getServer()", () => {
    it("should return the same instance on repeated calls for stdio", () => {
      const first = manager.getServer(TransportType.STDIO, serverOptions);
      const second = manager.getServer(TransportType.STDIO, serverOptions);

      expect(second).toBe(first);
    });

    it("should return the same instance on repeated calls for sse", () => {
      const first = manager.getServer(TransportType.SSE, serverOptions);
      const second = manager.getServer(TransportType.SSE, serverOptions);

      expect(second).toBe(first);
    });
  });
});
