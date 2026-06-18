import { AuthConfig } from "@src/mcp/transports/auth.js";
import { HttpServer } from "@src/mcp/transports/server.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const AUTH_CONFIG: AuthConfig = {
  apiKey: "test-key",
  enabled: true,
  allowedHosts: ["localhost"],
};

const openServers: HttpServer[] = [];

/**
 * Register an HttpServer so its real Fastify instance is closed in afterEach.
 * Each test constructs a live Fastify; closing it in teardown keeps the suite
 * free of leaked handles even on the rejection-path tests that never reach an
 * in-test close.
 */
function track(httpServer: HttpServer): HttpServer {
  openServers.push(httpServer);
  return httpServer;
}

afterEach(async () => {
  // Restore per-test spies first so a stubbed close()/listen() doesn't
  // intercept the real close below; `restoreMocks: true` only restores ahead
  // of the *next* test, which is too late for this teardown.
  vi.restoreAllMocks();
  await Promise.all(
    openServers.splice(0).map((httpServer) =>
      httpServer
        .getInstance()
        .close()
        .catch(() => {
          // teardown-only; a close failure shouldn't fail an asserted test
        }),
    ),
  );
});

describe("server.ts", () => {
  describe("HttpServer", () => {
    describe("prepare()", () => {
      it("should build the swagger servers[0].url from the passed ServerConfig", async () => {
        const httpServer = track(new HttpServer());
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
      });

      it("should register an onRequest auth hook when an auth config was supplied", async () => {
        const httpServer = track(new HttpServer({ auth: AUTH_CONFIG }));
        const addHook = vi.spyOn(httpServer.getInstance(), "addHook");

        await httpServer.prepare({ host: "test-host", port: 9999 });

        expect(addHook).toHaveBeenCalledWith("onRequest", expect.any(Function));
      });

      it("should not register an auth hook when no auth config was supplied", async () => {
        const httpServer = track(new HttpServer());
        const addHook = vi.spyOn(httpServer.getInstance(), "addHook");

        await httpServer.prepare({ host: "test-host", port: 9999 });

        expect(addHook).not.toHaveBeenCalledWith(
          "onRequest",
          expect.any(Function),
        );
      });

      it("should short-circuit a second prepare() without re-registering plugins", async () => {
        const httpServer = track(new HttpServer());
        await httpServer.prepare({ host: "test-host", port: 9999 });

        const register = vi.spyOn(httpServer.getInstance(), "register");
        await httpServer.prepare({ host: "test-host", port: 9999 });

        expect(register).not.toHaveBeenCalled();
      });
    });

    describe("start()", () => {
      it("should ready the instance then listen on the configured host and port", async () => {
        const httpServer = track(new HttpServer());
        const fastify = httpServer.getInstance();
        const ready = vi.spyOn(fastify, "ready").mockResolvedValue(fastify);
        // fastify's `listen` is overloaded; vi.spyOn resolves to the void-returning
        // overload, so the resolved address value is irrelevant here — we assert the
        // call arguments, not the return.
        const listen = vi.spyOn(fastify, "listen").mockResolvedValue(undefined);

        await httpServer.start({ host: "test-host", port: 9999 });

        expect(ready).toHaveBeenCalledOnce();
        expect(listen).toHaveBeenCalledWith({
          port: 9999,
          host: "test-host",
        });
      });

      it("should rethrow when listen fails", async () => {
        const httpServer = track(new HttpServer());
        const fastify = httpServer.getInstance();
        vi.spyOn(fastify, "ready").mockResolvedValue(fastify);
        vi.spyOn(fastify, "listen").mockRejectedValue(new Error("listen boom"));

        await expect(
          httpServer.start({ host: "test-host", port: 9999 }),
        ).rejects.toThrow("listen boom");
      });
    });

    describe("stop()", () => {
      it("should close the fastify instance", async () => {
        const httpServer = track(new HttpServer());
        const close = vi
          .spyOn(httpServer.getInstance(), "close")
          .mockResolvedValue(undefined);

        await httpServer.stop();

        expect(close).toHaveBeenCalledOnce();
      });

      it("should rethrow when close fails", async () => {
        const httpServer = track(new HttpServer());
        vi.spyOn(httpServer.getInstance(), "close").mockRejectedValue(
          new Error("close boom"),
        );

        await expect(httpServer.stop()).rejects.toThrow("close boom");
      });
    });
  });
});
