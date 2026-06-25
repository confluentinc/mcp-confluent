import * as nodeDeps from "@src/confluent/node-deps.js";
import {
  AuthConfig,
  CFLT_MCP_API_KEY_HEADER,
  createAuthHook,
  generateApiKey,
} from "@src/mcp/transports/auth.js";
import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it, vi, type Mock } from "vitest";

/**
 * Minimal stand-in for the slice of {@link FastifyReply} the auth hook touches:
 * a chainable `status().send()` pair whose calls the tests assert against.
 */
interface StubReply {
  status: Mock;
  send: Mock;
}

function makeReply(): FastifyReply & StubReply {
  const reply = {
    status: vi.fn(),
    send: vi.fn(),
  };
  reply.status.mockReturnValue(reply);
  reply.send.mockReturnValue(reply);
  return reply as unknown as FastifyReply & StubReply;
}

function makeRequest(
  headers: Record<string, string | string[] | undefined>,
): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

function expectPassed(reply: StubReply): void {
  expect(reply.status).not.toHaveBeenCalled();
  expect(reply.send).not.toHaveBeenCalled();
}

describe("generateApiKey()", () => {
  it("should hex-encode 32 random bytes into a 64-character string", () => {
    const randomBytes = vi
      .spyOn(nodeDeps.nodeCrypto, "randomBytes")
      .mockReturnValue(Buffer.alloc(32, 0xab));

    const key = generateApiKey();

    expect(randomBytes).toHaveBeenCalledWith(32);
    expect(key).toBe("ab".repeat(32));
    expect(key).toHaveLength(64);
  });
});

describe("createAuthHook()", () => {
  const API_KEY = "secret-key-aaaa";
  const ALLOWED_HOSTS = ["localhost", "127.0.0.1:8080"] as const;

  function authConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
    return {
      apiKey: API_KEY,
      enabled: true,
      allowedHosts: ALLOWED_HOSTS,
      ...overrides,
    };
  }

  describe("Host header validation (runs whether or not API key auth is enabled)", () => {
    it.each([
      { name: "missing Host header", host: undefined },
      { name: "unparseable Host header", host: "host:999999" },
      { name: "Host not in the allowed list", host: "evil.com:8080" },
    ])("should reject a request with a $name (403)", async ({ host }) => {
      const hook = createAuthHook(authConfig());
      const reply = makeReply();

      await hook(makeRequest({ host }), reply);

      expect(reply.status).toHaveBeenCalledWith(403);
      expect(reply.send).toHaveBeenCalledWith({
        error: "Forbidden",
        message: "Invalid Host header",
      });
    });

    it.each([
      {
        name: "exact hostname match ignoring the port",
        host: "localhost:9090",
      },
      {
        name: "full host:port match against the allowed entry",
        host: "127.0.0.1:8080",
      },
    ])("should accept a request whose Host is an $name", async ({ host }) => {
      // auth disabled isolates this assertion to the Host check — a pass means
      // status/send were never touched.
      const hook = createAuthHook(authConfig({ enabled: false }));
      const reply = makeReply();

      await hook(makeRequest({ host }), reply);

      expectPassed(reply);
    });
  });

  describe("API key validation (enabled)", () => {
    const VALID_HOST = "localhost";

    it("should accept a request bearing the configured API key", async () => {
      const hook = createAuthHook(authConfig());
      const reply = makeReply();

      await hook(
        makeRequest({ host: VALID_HOST, [CFLT_MCP_API_KEY_HEADER]: API_KEY }),
        reply,
      );

      expectPassed(reply);
    });

    it.each([
      { name: "the API key header is absent", apiKey: undefined },
      {
        name: "the API key header is an array, not a string",
        apiKey: [API_KEY, API_KEY],
      },
    ])("should reject when $name (401)", async ({ apiKey }) => {
      const hook = createAuthHook(authConfig());
      const reply = makeReply();

      await hook(
        makeRequest({ host: VALID_HOST, [CFLT_MCP_API_KEY_HEADER]: apiKey }),
        reply,
      );

      expect(reply.status).toHaveBeenCalledWith(401);
      expect(reply.send).toHaveBeenCalledWith({
        error: "Unauthorized",
        message: `Missing ${CFLT_MCP_API_KEY_HEADER} header`,
      });
    });

    it.each([
      { name: "same length but different content", apiKey: "secret-key-bbbb" },
      { name: "a different length entirely", apiKey: "x" },
    ])("should reject an API key of $name (401)", async ({ apiKey }) => {
      const hook = createAuthHook(authConfig());
      const reply = makeReply();

      await hook(
        makeRequest({ host: VALID_HOST, [CFLT_MCP_API_KEY_HEADER]: apiKey }),
        reply,
      );

      expect(reply.status).toHaveBeenCalledWith(401);
      expect(reply.send).toHaveBeenCalledWith({
        error: "Unauthorized",
        message: "Invalid API key",
      });
    });
  });

  it("should skip API key validation entirely when auth is disabled", async () => {
    // A valid Host with no API key header must still pass when disabled.
    const hook = createAuthHook(authConfig({ enabled: false }));
    const reply = makeReply();

    await hook(makeRequest({ host: "localhost" }), reply);

    expectPassed(reply);
  });
});
