import { FastifyReply, FastifyRequest } from "fastify";

export const pingRequestSchema = {
  type: "object",
  properties: {
    jsonrpc: { type: "string", enum: ["2.0"] },
    id: { type: "string" },
    method: { type: "string", enum: ["ping"] },
  },
  required: ["jsonrpc", "id", "method"],
};

export const pingResponseSchema = {
  type: "object",
  properties: {
    jsonrpc: { type: "string" },
    id: { type: "string" },
    result: { type: "object", additionalProperties: false },
  },
  required: ["jsonrpc", "id", "result"],
};

export function pingHandler() {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.body as { id: string };

    reply.send({
      jsonrpc: "2.0",
      id,
      result: {},
    });
  };
}
