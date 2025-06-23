import { FastifyReply, FastifyRequest } from "fastify";

export const pingResponseSchema = {
  type: "object",
  properties: {
    status: { type: "string" },
    timestamp: { type: "string", format: "date-time" },
    transport: { type: "string" },
  },
};

export function pingHandler(transport: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    reply.send({
      status: "ok",
      timestamp: new Date().toISOString(),
      transport,
    });
  };
}
