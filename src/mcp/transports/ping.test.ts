import { pingHandler } from "@src/mcp/transports/ping.js";
import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it, vi, type Mock } from "vitest";

interface StubReply {
  send: Mock;
}

function makeReply(): FastifyReply & StubReply {
  const reply = { send: vi.fn() };
  return reply as unknown as FastifyReply & StubReply;
}

function makeRequest(body: Record<string, unknown>): FastifyRequest {
  return { body } as unknown as FastifyRequest;
}

describe("pingHandler()", () => {
  it.each([{ id: "req-1" }, { id: "550e8400-e29b-41d4-a716-446655440000" }])(
    "should echo id '$id' back in a JSON-RPC 2.0 result",
    async ({ id }) => {
      const handler = pingHandler();
      const reply = makeReply();

      await handler(makeRequest({ id, jsonrpc: "2.0", method: "ping" }), reply);

      expect(reply.send).toHaveBeenCalledOnce();
      expect(reply.send).toHaveBeenCalledWith({
        jsonrpc: "2.0",
        id,
        result: {},
      });
    },
  );
});
