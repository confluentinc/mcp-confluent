import { HttpServer } from "@src/mcp/transports/server.js";
import { describe, expect, it } from "vitest";

describe("server.ts", () => {
  describe("HttpServer", () => {
    describe("prepare()", () => {
      it("should build the swagger servers[0].url from the passed ServerConfig", async () => {
        const httpServer = new HttpServer();
        await httpServer.prepare({ host: "test-host", port: 9999 });

        // @fastify/swagger augments the FastifyInstance with .swagger() but
        // requires .ready() first so the spec is materialized.
        const fastify = httpServer.getInstance();
        await fastify.ready();
        const spec = (
          fastify as unknown as {
            swagger: () => { servers?: { url: string }[] };
          }
        ).swagger();

        expect(spec.servers?.[0]?.url).toBe("http://test-host:9999");

        await fastify.close();
      });
    });
  });
});
