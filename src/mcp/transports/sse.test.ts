import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import * as nodeDeps from "@src/confluent/node-deps.js";
import { HttpServer } from "@src/mcp/transports/server.js";
import { SessionRegistry } from "@src/mcp/transports/session-registry.js";
import { SseTransport } from "@src/mcp/transports/sse.js";
import {
  createMockInstance,
  createMockSessionRegistry,
  createMockSseServerTransport,
  MOCK_SESSION_ID,
} from "@tests/stubs/index.js";
import Fastify, { FastifyInstance } from "fastify";
import { ServerResponse } from "node:http";
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

describe("SseTransport", () => {
  let fastify: FastifyInstance;
  let sseTransport: SseTransport;
  let httpServer: Mocked<HttpServer>;
  let serverFactory: Mock<() => McpServer>;
  let mockSessions: Mocked<SessionRegistry<SSEServerTransport>>;

  beforeEach(async () => {
    // real: fastify (for inject()), sseTransport (unit under test).
    // stubbed: httpServer, serverFactory, sessions registry — every collaborator the route
    // handlers reach for is a Mocked instance so behavior is isolated to SseTransport.
    fastify = Fastify();
    httpServer = createMockInstance(HttpServer);
    httpServer.getInstance.mockReturnValue(fastify);
    serverFactory = vi.fn<() => McpServer>(() => createMockInstance(McpServer));
    sseTransport = new SseTransport(serverFactory, httpServer);
    mockSessions = createMockSessionRegistry<SSEServerTransport>();
    sseTransport["sessions"] = mockSessions;
    await sseTransport.connect();
  });

  afterEach(async () => {
    await fastify.close();
  });

  describe("GET /sse", () => {
    let newTransport: ReturnType<typeof createMockSseServerTransport>;

    beforeEach(() => {
      newTransport = createMockSseServerTransport();
    });

    it("should construct a per-session server, bind it, and register the session", async () => {
      // SDK's SSEServerTransport constructor takes (endpointPath, ServerResponse) and is
      // expected to keep the response open for streaming. The success-path mock immediately
      // ends it so fastify.inject() resolves; the failure-path test below leaves the response
      // open so the route handler's catch block can write the 400.
      vi.spyOn(nodeDeps.sdkTransports, "SSEServerTransport").mockImplementation(
        function MockSSEServerTransport(
          this: unknown,
          _path: string,
          res: ServerResponse,
        ) {
          res.end();
          return newTransport;
        } as never,
      );

      const response = await fastify.inject({ method: "GET", url: "/sse" });

      expect(response.statusCode).toBe(200);
      expect(serverFactory).toHaveBeenCalledOnce();
      expect(mockSessions.bindServer).toHaveBeenCalledOnce();
      expect(mockSessions.set).toHaveBeenCalledWith(
        MOCK_SESSION_ID,
        expect.objectContaining({ transport: newTransport }),
      );
      // production code wires onclose so abandoned sessions can't leak
      expect(newTransport.onclose).toBeTypeOf("function");
    });

    it("should respond 400 and roll back the registry entry when bindServer rejects", async () => {
      // leave the response open so the route handler's catch block can write the 400
      vi.spyOn(nodeDeps.sdkTransports, "SSEServerTransport").mockImplementation(
        function MockSSEServerTransport(this: unknown) {
          return newTransport;
        } as never,
      );
      mockSessions.bindServer.mockRejectedValueOnce(new Error("connect boom"));

      const response = await fastify.inject({ method: "GET", url: "/sse" });

      expect(response.statusCode).toBe(400);
      // set ran before bind (new ordering); closeAndRemove rolls it back so the registry
      // never permanently holds an unbound entry
      expect(mockSessions.set).toHaveBeenCalledOnce();
      expect(mockSessions.closeAndRemove).toHaveBeenCalledWith(MOCK_SESSION_ID);
    });
  });

  describe("POST /messages", () => {
    it("should respond 400 when the sessionId query param references an unknown session", async () => {
      const response = await fastify.inject({
        method: "POST",
        url: "/messages",
        query: { sessionId: UNKNOWN_SESSION },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      });

      expect(response.statusCode).toBe(400);
    });

    it("should forward to the existing transport when the sessionId is known", async () => {
      const knownTransport = createMockSseServerTransport();
      mockSessions.get.mockReturnValue({
        transport: knownTransport,
        server: createMockInstance(McpServer),
      });

      const response = await fastify.inject({
        method: "POST",
        url: "/messages",
        query: { sessionId: MOCK_SESSION_ID },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      });

      expect(response.statusCode).toBe(200);
      expect(knownTransport.handlePostMessage).toHaveBeenCalledOnce();
    });
  });

  describe("createSession()", () => {
    let newTransport: ReturnType<typeof createMockSseServerTransport>;
    let rawResponse: Mocked<ServerResponse>;

    beforeEach(() => {
      // production code does `new sdkTransports.SSEServerTransport(...)` inside
      // createSession(); spy on the constructor so it returns a test-controlled mock
      // instead of standing up the real SDK class. Tests assign `newTransport` before
      // invoking createSession and the closure reads it lazily at construction time.
      vi.spyOn(nodeDeps.sdkTransports, "SSEServerTransport").mockImplementation(
        function MockSSEServerTransport(this: unknown) {
          return newTransport;
        } as never,
      );
      rawResponse = {
        end: vi.fn(),
      } as unknown as Mocked<ServerResponse>;
    });

    it("should register the session before binding so a fast client POST can find it", async () => {
      newTransport = createMockSseServerTransport();
      // capture call order: set must precede bindServer to close the race window where the
      // SDK's start() endpoint event reaches the client before sessions.set runs
      const callOrder: string[] = [];
      mockSessions.set.mockImplementation(() => {
        callOrder.push("set");
      });
      mockSessions.bindServer.mockImplementation(async () => {
        callOrder.push("bindServer");
      });

      await sseTransport["createSession"](rawResponse);

      expect(mockSessions.set).toHaveBeenCalledWith(
        MOCK_SESSION_ID,
        expect.objectContaining({ transport: newTransport }),
      );
      expect(callOrder).toEqual(["set", "bindServer"]);
    });

    it("should call closeAndRemove with the session id when onclose fires", async () => {
      newTransport = createMockSseServerTransport();

      await sseTransport["createSession"](rawResponse);
      newTransport.onclose?.();

      expect(mockSessions.closeAndRemove).toHaveBeenCalledWith(MOCK_SESSION_ID);
    });

    it("should throw when the SDK transport has no session id", async () => {
      newTransport = createMockSseServerTransport();
      // factory's default fills in MOCK_SESSION_ID; override to exercise the early-throw branch.
      // sessionId is a getter on the SDK class (so typed read-only), but the factory installs
      // it as a writable data prop, so the runtime assignment is fine.
      (newTransport as { sessionId: string | undefined }).sessionId = undefined;

      await expect(sseTransport["createSession"](rawResponse)).rejects.toThrow(
        /session ID/i,
      );
      expect(mockSessions.bindServer).not.toHaveBeenCalled();
    });

    it("should evict the registry entry and propagate the error when bindServer rejects", async () => {
      newTransport = createMockSseServerTransport();
      mockSessions.bindServer.mockRejectedValueOnce(new Error("connect boom"));

      await expect(sseTransport["createSession"](rawResponse)).rejects.toThrow(
        "connect boom",
      );
      // set ran before bind (per the new ordering); closeAndRemove rolls it back on rejection
      expect(mockSessions.set).toHaveBeenCalledOnce();
      expect(mockSessions.closeAndRemove).toHaveBeenCalledWith(MOCK_SESSION_ID);
    });
  });

  describe("disconnect()", () => {
    it("should delegate to SessionRegistry.closeAll", async () => {
      await sseTransport.disconnect();

      expect(mockSessions.closeAll).toHaveBeenCalledOnce();
    });
  });
});
