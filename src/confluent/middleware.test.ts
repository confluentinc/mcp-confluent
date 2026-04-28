import { Middleware } from "openapi-fetch";
import { describe, expect, it } from "vitest";

import {
  BearerTokenUnavailableError,
  createAuthMiddleware,
  createBearerMiddleware,
} from "@src/confluent/middleware.js";

type OnRequestArg = Parameters<NonNullable<Middleware["onRequest"]>>[0];

/**
 * The openapi-fetch Middleware.onRequest signature requires several
 * parameters that this middleware doesn't use. This helper builds a
 * minimal-but-typed call so each test can focus on the request alone.
 */
async function callOnRequest(
  middleware: ReturnType<typeof createBearerMiddleware>,
  request: Request,
): Promise<Request | Response | void | undefined> {
  if (!middleware.onRequest) throw new Error("middleware.onRequest missing");
  return middleware.onRequest({
    request,
    schemaPath: "/test",
    params: {} as OnRequestArg["params"],
    options: {} as OnRequestArg["options"],
    id: "test-id",
  });
}

describe("middleware.ts", () => {
  describe("BearerTokenUnavailableError", () => {
    it("should be an Error subclass with the expected name", () => {
      const err = new BearerTokenUnavailableError("token gone");
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe("BearerTokenUnavailableError");
      expect(err.message).toBe("token gone");
    });
  });

  describe("createBearerMiddleware", () => {
    it("should attach Authorization: Bearer <token> when the getter returns a token", async () => {
      const middleware = createBearerMiddleware(() => "abc123");
      const request = new Request("https://example.com/api");

      await callOnRequest(middleware, request);

      expect(request.headers.get("Authorization")).toBe("Bearer abc123");
    });

    it("should throw BearerTokenUnavailableError when the getter returns undefined", async () => {
      const middleware = createBearerMiddleware(() => undefined);
      const request = new Request("https://example.com/api");

      await expect(callOnRequest(middleware, request)).rejects.toThrow(
        BearerTokenUnavailableError,
      );
      expect(request.headers.has("Authorization")).toBe(false);
    });

    it("should throw BearerTokenUnavailableError when the getter returns an empty string", async () => {
      const middleware = createBearerMiddleware(() => "");
      const request = new Request("https://example.com/api");

      await expect(callOnRequest(middleware, request)).rejects.toThrow(
        BearerTokenUnavailableError,
      );
      expect(request.headers.has("Authorization")).toBe(false);
    });

    it("should set the User-Agent header on success", async () => {
      const middleware = createBearerMiddleware(() => "tok");
      const request = new Request("https://example.com/api");

      await callOnRequest(middleware, request);

      expect(request.headers.get("User-Agent")).toMatch(
        /^mcp-confluent-local\//,
      );
    });
  });

  describe("createAuthMiddleware", () => {
    it("should attach a bearer header when type is 'oauth'", async () => {
      const middleware = createAuthMiddleware({
        type: "oauth",
        getToken: () => "xyz789",
      });
      const request = new Request("https://example.com/api");

      await callOnRequest(middleware, request);

      expect(request.headers.get("Authorization")).toBe("Bearer xyz789");
    });

    it("should attach a basic header when type is 'api_key'", async () => {
      const middleware = createAuthMiddleware({
        type: "api_key",
        apiKey: "k",
        apiSecret: "s",
      });
      const request = new Request("https://example.com/api");

      await callOnRequest(middleware, request);

      expect(request.headers.get("Authorization")).toMatch(/^Basic /);
    });

    it("should attach a basic header when type is omitted", async () => {
      const middleware = createAuthMiddleware({ apiKey: "k", apiSecret: "s" });
      const request = new Request("https://example.com/api");

      await callOnRequest(middleware, request);

      expect(request.headers.get("Authorization")).toMatch(/^Basic /);
    });
  });
});
