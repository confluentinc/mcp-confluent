import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolHandler } from "@src/confluent/tools/base-tools.js";
import type { ToolName } from "@src/confluent/tools/tool-name.js";
import type { CreateMcpServerOptions } from "@src/mcp/server.js";
import { HttpTransport } from "@src/mcp/transports/http.js";
import type { HttpStartOptions } from "@src/mcp/transports/manager.js";
import { TransportManager } from "@src/mcp/transports/manager.js";
import type { HttpServer } from "@src/mcp/transports/server.js";
import { SseTransport } from "@src/mcp/transports/sse.js";
import type { Transport } from "@src/mcp/transports/types.js";
import { TransportType } from "@src/mcp/transports/types.js";
import { runtimeWith } from "@tests/factories/runtime.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const HTTP_OPTS: HttpStartOptions = {
  port: 0,
  host: "localhost",
  mcpEndpointPath: "/mcp",
  sseEndpointPath: "/sse",
  sseMessageEndpointPath: "/messages",
};

function fakeHttpServer(): HttpServer {
  return {
    stop: vi.fn().mockResolvedValue(undefined),
  } as unknown as HttpServer;
}

/**
 * Transport stub exposing only the `disconnect` the manager's `stop()` calls,
 * with a configurable rejection to drive the per-transport error-tolerance arm.
 */
function fakeTransport(
  disconnect = vi.fn().mockResolvedValue(undefined),
): Transport {
  return { disconnect } as unknown as Transport;
}

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

  describe("start()", () => {
    it("should reject when HTTP/SSE is requested without `http` start options, and clean up", async () => {
      await expect(
        manager.start({ serverOptions, types: [TransportType.HTTP] }),
      ).rejects.toThrow(
        "HTTP/SSE transports require `http` start options (port, host)",
      );

      // the catch arm runs stop(); nothing was constructed, so the manager is left clean
      expect(manager["transports"].size).toBe(0);
      expect(manager["httpServer"]).toBeNull();
    });

    it("should reject when auth is enabled but no API key is configured", async () => {
      // default config => auth enabled, apiKey undefined; `http` is supplied so the
      // earlier http-options guard passes and we reach the API-key guard
      await expect(
        manager.start({
          serverOptions,
          types: [TransportType.HTTP],
          http: HTTP_OPTS,
        }),
      ).rejects.toThrow(
        "MCP_API_KEY is required when authentication is enabled for HTTP/SSE transports. " +
          "Generate a key using: npx mcp-confluent --generate-key",
      );

      expect(manager["httpServer"]).toBeNull();
    });
  });

  describe("stop()", () => {
    it("should resolve as a no-op on a manager that was never started", async () => {
      await expect(manager.stop()).resolves.toBeUndefined();

      expect(manager["transports"].size).toBe(0);
      expect(manager["httpServer"]).toBeNull();
      expect(manager["stdioServer"]).toBeNull();
    });

    it("should stop the HTTP server, disconnect every transport, close the stdio server, and reset all state", async () => {
      const httpServer = fakeHttpServer();
      const httpTransport = fakeTransport();
      const stdioTransport = fakeTransport();
      const stdioServer = {
        close: vi.fn().mockResolvedValue(undefined),
      } as unknown as McpServer;

      manager["httpServer"] = httpServer;
      manager["stdioServer"] = stdioServer;
      manager["transports"].set(TransportType.HTTP, httpTransport);
      manager["transports"].set(TransportType.STDIO, stdioTransport);

      await manager.stop();

      expect(httpServer.stop).toHaveBeenCalledOnce();
      expect(httpTransport.disconnect).toHaveBeenCalledOnce();
      expect(stdioTransport.disconnect).toHaveBeenCalledOnce();
      expect(stdioServer.close).toHaveBeenCalledOnce();

      expect(manager["transports"].size).toBe(0);
      expect(manager["httpServer"]).toBeNull();
      expect(manager["stdioServer"]).toBeNull();
    });

    it("should disconnect remaining transports and finish cleanup even when one transport's disconnect rejects", async () => {
      const failing = fakeTransport(
        vi.fn().mockRejectedValue(new Error("disconnect boom")),
      );
      const healthy = fakeTransport();
      manager["transports"].set(TransportType.HTTP, failing);
      manager["transports"].set(TransportType.SSE, healthy);

      await expect(manager.stop()).resolves.toBeUndefined();

      expect(failing.disconnect).toHaveBeenCalledOnce();
      expect(healthy.disconnect).toHaveBeenCalledOnce();
      expect(manager["transports"].size).toBe(0);
    });
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

    it.each([TransportType.HTTP, TransportType.SSE])(
      "should throw when %s transport is created before the HTTP server is initialized",
      (type) => {
        expect(() =>
          manager["createTransport"](type, serverOptions, HTTP_OPTS),
        ).toThrow("HTTP server not initialized");
      },
    );

    it("should construct an HttpTransport once the HTTP server is initialized", () => {
      manager["httpServer"] = fakeHttpServer();

      const transport = manager["createTransport"](
        TransportType.HTTP,
        serverOptions,
        HTTP_OPTS,
      );

      expect(transport).toBeInstanceOf(HttpTransport);
    });

    it("should construct an SseTransport once the HTTP server is initialized", () => {
      manager["httpServer"] = fakeHttpServer();

      const transport = manager["createTransport"](
        TransportType.SSE,
        serverOptions,
        HTTP_OPTS,
      );

      expect(transport).toBeInstanceOf(SseTransport);
    });

    it("should throw on an unsupported transport type", () => {
      expect(() =>
        manager["createTransport"](
          "ftp" as TransportType,
          serverOptions,
          undefined,
        ),
      ).toThrow("Unsupported transport type: ftp");
    });
  });
});
