import { createRetryOn429Middleware } from "@tests/harness/retry-on-429.js";
import type { Middleware } from "openapi-fetch";
import { describe, expect, it, vi } from "vitest";

// invokes onResponse with a stub MiddlewareCallbackParams; the middleware
// only consumes `request` and `response`.
async function invokeOnResponse(
  middleware: Middleware,
  request: Request,
  response: Response,
) {
  if (!middleware.onResponse) {
    throw new Error("middleware must define onResponse");
  }
  return middleware.onResponse({
    request,
    response,
    schemaPath: "",
    params: {},
    id: "test",
    options: {},
  } as Parameters<NonNullable<Middleware["onResponse"]>>[0]);
}

const makeReq = () =>
  new Request("https://api.example.com/test", { method: "GET" });
const makeOk = () => new Response("ok", { status: 200 });
const make429 = (headers: HeadersInit = {}) =>
  new Response(null, { status: 429, headers });

describe("retry-on-429.ts", () => {
  describe("createRetryOn429Middleware", () => {
    it("should pass through non-429 responses untouched", async () => {
      const fetchSpy = vi.fn();
      const sleep = vi.fn().mockResolvedValue(undefined);
      const middleware = createRetryOn429Middleware({
        fetch: fetchSpy,
        sleep,
      });

      const result = await invokeOnResponse(middleware, makeReq(), makeOk());

      expect(result).toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(sleep).not.toHaveBeenCalled();
    });

    it("should retry on 429 and return the first non-429 response", async () => {
      const fetchSpy = vi.fn().mockResolvedValue(makeOk());
      const sleep = vi.fn().mockResolvedValue(undefined);
      const middleware = createRetryOn429Middleware({
        fetch: fetchSpy,
        sleep,
      });

      const result = await invokeOnResponse(middleware, makeReq(), make429());

      expect(result?.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(sleep).toHaveBeenCalledOnce();
    });

    it("should honor Retry-After header in numeric-seconds form", async () => {
      const fetchSpy = vi.fn().mockResolvedValue(makeOk());
      const sleep = vi.fn().mockResolvedValue(undefined);
      const middleware = createRetryOn429Middleware({
        fetch: fetchSpy,
        sleep,
      });

      await invokeOnResponse(
        middleware,
        makeReq(),
        make429({ "Retry-After": "2" }),
      );

      expect(sleep).toHaveBeenCalledWith(2000);
    });

    it("should honor Retry-After header in HTTP-date form", async () => {
      const fetchSpy = vi.fn().mockResolvedValue(makeOk());
      const sleep = vi.fn().mockResolvedValue(undefined);
      const middleware = createRetryOn429Middleware({
        fetch: fetchSpy,
        sleep,
      });

      // freeze Date.now() so the middleware's HTTP-date math is deterministic.
      const fixedNow = 1_700_000_000_000;
      vi.useFakeTimers({ now: fixedNow });
      try {
        const retryAt = new Date(fixedNow + 3000);
        await invokeOnResponse(
          middleware,
          makeReq(),
          make429({ "Retry-After": retryAt.toUTCString() }),
        );

        expect(sleep).toHaveBeenCalledWith(3000);
      } finally {
        vi.useRealTimers();
      }
    });

    it("should fall back to exponential backoff with jitter when Retry-After is absent", async () => {
      const fetchSpy = vi.fn().mockResolvedValue(makeOk());
      const sleep = vi.fn().mockResolvedValue(undefined);
      const middleware = createRetryOn429Middleware({
        fetch: fetchSpy,
        sleep,
        baseBackoffMs: 500,
      });

      await invokeOnResponse(middleware, makeReq(), make429());

      expect(sleep).toHaveBeenCalledOnce();
      const delay = sleep.mock.calls[0]![0] as number;
      // first attempt: base * 2^0 = 500, plus uniform jitter in [0, 500)
      expect(delay).toBeGreaterThanOrEqual(500);
      expect(delay).toBeLessThan(1000);
    });

    it("should cap at maxAttempts and return the final 429 on exhaustion", async () => {
      const fetchSpy = vi.fn().mockResolvedValue(make429());
      const sleep = vi.fn().mockResolvedValue(undefined);
      const middleware = createRetryOn429Middleware({
        fetch: fetchSpy,
        sleep,
        maxAttempts: 3,
      });

      const result = await invokeOnResponse(middleware, makeReq(), make429());

      expect(result?.status).toBe(429);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(sleep).toHaveBeenCalledTimes(3);
    });

    it("should re-issue with a cloned Request so headers (auth) are preserved across retries", async () => {
      const fetchSpy = vi.fn().mockResolvedValue(makeOk());
      const sleep = vi.fn().mockResolvedValue(undefined);
      const middleware = createRetryOn429Middleware({
        fetch: fetchSpy,
        sleep,
      });

      const req = new Request("https://api.example.com/test", {
        method: "GET",
        headers: { Authorization: "Basic abc123" },
      });

      await invokeOnResponse(middleware, req, make429());

      const fetched = fetchSpy.mock.calls[0]![0] as Request;
      expect(fetched.headers.get("Authorization")).toBe("Basic abc123");
      // openapi-fetch may have already consumed the original Request's body,
      // so the middleware must clone before re-issuing.
      expect(fetched).not.toBe(req);
    });
  });
});
