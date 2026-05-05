import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as nodeDeps from "@src/confluent/node-deps.js";
import { HttpTransport } from "@src/mcp/transports/http.js";
import { HttpServer } from "@src/mcp/transports/server.js";
import {
  createMockHttpServerTransport,
  createMockInstance,
  MOCK_SESSION_ID,
} from "@tests/stubs/index.js";
import Fastify, { FastifyInstance } from "fastify";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  type Mocked,
  vi,
} from "vitest";

const UNKNOWN_SESSION = "22222222-2222-2222-2222-222222222222";

describe("HttpTransport", () => {
  let fastify: FastifyInstance;
  let httpTransport: HttpTransport;
  let httpServer: Mocked<HttpServer>;
  let serverFactory: Mock<() => McpServer>;

  beforeEach(async () => {
    // real: fastify (for inject()), httpTransport (unit under test).
    // stubbed: httpServer (only getInstance has a return value), serverFactory (returns a mocked McpServer).
    fastify = Fastify();
    httpServer = createMockInstance(HttpServer);
    httpServer.getInstance.mockReturnValue(fastify);
    serverFactory = vi.fn<() => McpServer>(() => createMockInstance(McpServer));
    httpTransport = new HttpTransport(serverFactory, httpServer);
    await httpTransport.connect();
  });

  afterEach(async () => {
    await fastify.close();
  });

  describe("POST /mcp", () => {
    it("should respond 400 to a sessionless POST whose body isn't an initialize request and never invoke the server factory", async () => {
      const response = await fastify.inject({
        method: "POST",
        url: "/mcp",
        payload: { jsonrpc: "2.0", id: 1, method: "ping" },
      });

      expect(response.statusCode).toBe(400);
      expect(serverFactory).not.toHaveBeenCalled();
    });

    it("should respond 404 when the mcp-session-id header references an unknown session", async () => {
      const response = await fastify.inject({
        method: "POST",
        url: "/mcp",
        headers: { "mcp-session-id": UNKNOWN_SESSION },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      });

      expect(response.statusCode).toBe(404);
      expect(serverFactory).not.toHaveBeenCalled();
    });

    it("should forward to the existing transport when the session id is known", async () => {
      const knownTransport = createMockHttpServerTransport();
      httpTransport["sessions"].set(MOCK_SESSION_ID, {
        transport: knownTransport,
        server: createMockInstance(McpServer),
      });

      const response = await fastify.inject({
        method: "POST",
        url: "/mcp",
        headers: { "mcp-session-id": MOCK_SESSION_ID },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      });

      expect(response.statusCode).toBe(200);
      expect(knownTransport.handleRequest).toHaveBeenCalledOnce();
      expect(serverFactory).not.toHaveBeenCalled();
    });

    it("should construct a per-session server, bind it, and forward the body when an initialize POST arrives", async () => {
      const newTransport = createMockHttpServerTransport();
      const transportConstructorStub = vi
        .spyOn(nodeDeps.sdkTransports, "StreamableHTTPServerTransport")
        .mockImplementation(function MockStreamableHTTPServerTransport(
          this: unknown,
        ) {
          return newTransport;
        });
      const bindServerSpy = vi.spyOn(httpTransport["sessions"], "bindServer");

      const response = await fastify.inject({
        method: "POST",
        url: "/mcp",
        payload: {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "test-client", version: "0.0.0" },
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(serverFactory).toHaveBeenCalledOnce();
      expect(transportConstructorStub).toHaveBeenCalledOnce();
      expect(bindServerSpy).toHaveBeenCalledOnce();
      expect(newTransport.handleRequest).toHaveBeenCalledOnce();
      // production code wires onclose so abandoned sessions can't leak
      expect(newTransport.onclose).toBeTypeOf("function");
    });
  });

  describe("GET /mcp", () => {
    it("should respond 404 when the mcp-session-id header references an unknown session", async () => {
      const response = await fastify.inject({
        method: "GET",
        url: "/mcp",
        headers: { "mcp-session-id": UNKNOWN_SESSION },
      });

      expect(response.statusCode).toBe(404);
    });

    it("should forward to the existing transport when the session id is known", async () => {
      const knownTransport = createMockHttpServerTransport();
      httpTransport["sessions"].set(MOCK_SESSION_ID, {
        transport: knownTransport,
        server: createMockInstance(McpServer),
      });

      const response = await fastify.inject({
        method: "GET",
        url: "/mcp",
        headers: { "mcp-session-id": MOCK_SESSION_ID },
      });

      expect(response.statusCode).toBe(200);
      expect(knownTransport.handleRequest).toHaveBeenCalledOnce();
    });
  });

  describe("DELETE /mcp", () => {
    it("should respond 404 when the mcp-session-id header references an unknown session", async () => {
      const response = await fastify.inject({
        method: "DELETE",
        url: "/mcp",
        headers: { "mcp-session-id": UNKNOWN_SESSION },
      });

      expect(response.statusCode).toBe(404);
    });

    it("should delegate cleanup to the SDK transport when the session id is known", async () => {
      const knownTransport = createMockHttpServerTransport();
      httpTransport["sessions"].set(MOCK_SESSION_ID, {
        transport: knownTransport,
        server: createMockInstance(McpServer),
      });

      const response = await fastify.inject({
        method: "DELETE",
        url: "/mcp",
        headers: { "mcp-session-id": MOCK_SESSION_ID },
      });

      expect(response.statusCode).toBe(200);
      expect(knownTransport.handleRequest).toHaveBeenCalledOnce();
    });
  });

  describe("disconnect()", () => {
    it("should delegate to SessionRegistry.closeAll", async () => {
      const closeAllSpy = vi.spyOn(httpTransport["sessions"], "closeAll");

      await httpTransport.disconnect();

      expect(closeAllSpy).toHaveBeenCalledOnce();
    });
  });
});
