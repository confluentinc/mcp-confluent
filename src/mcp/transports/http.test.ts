import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as nodeDeps from "@src/confluent/node-deps.js";
import { HttpTransport } from "@src/mcp/transports/http.js";
import { HttpServer } from "@src/mcp/transports/server.js";
import { SessionRegistry } from "@src/mcp/transports/session-registry.js";
import {
  createMockHttpServerTransport,
  createMockInstance,
  createMockSessionRegistry,
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
  let mockSessions: Mocked<SessionRegistry<StreamableHTTPServerTransport>>;

  beforeEach(async () => {
    // real: fastify (for inject()), httpTransport (unit under test).
    // stubbed: httpServer, serverFactory, sessions registry — every collaborator the route
    // handlers reach for is a Mocked instance so behavior is isolated to HttpTransport.
    fastify = Fastify();
    httpServer = createMockInstance(HttpServer);
    httpServer.getInstance.mockReturnValue(fastify);
    serverFactory = vi.fn<() => McpServer>(() => createMockInstance(McpServer));
    httpTransport = new HttpTransport(serverFactory, httpServer);
    mockSessions = createMockSessionRegistry<StreamableHTTPServerTransport>();
    httpTransport["sessions"] = mockSessions;
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
      mockSessions.get.mockReturnValue({
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
      expect(mockSessions.bindServer).toHaveBeenCalledOnce();
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
      mockSessions.get.mockReturnValue({
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
      mockSessions.get.mockReturnValue({
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

  describe("createSession()", () => {
    let newTransport: ReturnType<typeof createMockHttpServerTransport>;

    beforeEach(() => {
      // production code does `new sdkTransports.StreamableHTTPServerTransport(...)` inside
      // createSession(), so we need to spy on the constructor so it returns a test-controlled mock
      // instead of standing up the real SDK class; tests assign `newTransport` before invoking
      // createSession and the closure reads it lazily at construction time
      vi.spyOn(
        nodeDeps.sdkTransports,
        "StreamableHTTPServerTransport",
      ).mockImplementation(function MockStreamableHTTPServerTransport(
        this: unknown,
      ) {
        return newTransport;
      });
    });

    it("should register the session when onsessioninitialized fires", async () => {
      newTransport = createMockHttpServerTransport();

      await httpTransport["createSession"]();
      vi.mocked(
        nodeDeps.sdkTransports.StreamableHTTPServerTransport,
      ).mock.calls[0]?.[0]?.onsessioninitialized?.(MOCK_SESSION_ID);

      expect(mockSessions.set).toHaveBeenCalledWith(
        MOCK_SESSION_ID,
        expect.objectContaining({ transport: newTransport }),
      );
    });

    it("should call closeAndRemove with the session id when onclose fires", async () => {
      newTransport = createMockHttpServerTransport(MOCK_SESSION_ID);

      await httpTransport["createSession"]();
      newTransport.onclose?.();

      expect(mockSessions.closeAndRemove).toHaveBeenCalledWith(MOCK_SESSION_ID);
    });

    it("should no-op the onclose handler when the transport has no session id", async () => {
      newTransport = createMockHttpServerTransport();
      // factory's default fills in MOCK_SESSION_ID; override to exercise the early-return branch.
      // sessionId is a getter on the SDK class (so typed read-only), but the factory installs
      // it as a writable data prop, so the runtime assignment is fine.
      (newTransport as { sessionId: string | undefined }).sessionId = undefined;

      await httpTransport["createSession"]();
      newTransport.onclose?.();

      expect(mockSessions.closeAndRemove).not.toHaveBeenCalled();
    });

    it("should propagate errors from bindServer", async () => {
      newTransport = createMockHttpServerTransport();
      mockSessions.bindServer.mockRejectedValue(new Error("connect boom"));

      await expect(httpTransport["createSession"]()).rejects.toThrow(
        "connect boom",
      );
    });
  });

  describe("disconnect()", () => {
    it("should delegate to SessionRegistry.closeAll", async () => {
      await httpTransport.disconnect();

      expect(mockSessions.closeAll).toHaveBeenCalledOnce();
    });
  });
});
