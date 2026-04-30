import { logger } from "@src/logger.js";
import { Middleware } from "openapi-fetch";
import pkg from "../../package.json" with { type: "json" };

/**
 * Thrown by the bearer middleware when the token getter returns undefined —
 * typically because OAuth bootstrap has not completed (or has been cleared by
 * shutdown) at the moment a request is about to be sent. Surfaces a clear
 * message for callers; tool handlers can catch it explicitly to return
 * `{ isError: true }` instead of letting it propagate as a protocol-level
 * error from the MCP transport.
 */
export class BearerTokenUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BearerTokenUnavailableError";
  }
}

/**
 * Build a {@link Middleware} that attaches `Authorization: Bearer <token>`
 * read from `getToken()` and sets a `User-Agent` header containing this
 * package's version. The closure is supplied by the caller; this middleware
 * has no knowledge of where the token comes from or when it expires. Throws
 * {@link BearerTokenUnavailableError} when `getToken` returns `undefined`.
 */
export const createBearerMiddleware = (
  getToken: () => string | undefined,
): Middleware => ({
  async onRequest({ request }) {
    const token = getToken();
    if (!token) {
      throw new BearerTokenUnavailableError(
        "OAuth token is not currently available.",
      );
    }
    request.headers.set("Authorization", `Bearer ${token}`);
    request.headers.set("User-Agent", `mcp-confluent-local/${pkg.version}`);
    return request;
  },
});

export interface ConfluentEndpoints {
  cloud?: string;
  tableflow?: string;
  flink?: string;
  schemaRegistry?: string;
  kafka?: string;
  telemetry?: string;
}

/**
 * Discriminated union over the two authentication shapes the middleware
 * understands. The `api_key` variant's `type` field is optional so existing
 * call sites that pass `{ apiKey, apiSecret }` keep working.
 */
export type ConfluentAuth =
  | { type?: "api_key"; apiKey?: string; apiSecret?: string }
  | { type: "oauth"; getToken: () => string | undefined };

/**
 * Creates a middleware that attaches an Authorization header. Dispatches on
 * the `type` discriminator: `oauth` → bearer; `api_key` (or unset) → Basic.
 */
export const createAuthMiddleware = (auth: ConfluentAuth): Middleware => {
  if (auth.type === "oauth") {
    return createBearerMiddleware(auth.getToken);
  }
  return createApiKeyMiddleware(auth);
};

/**
 * Original Basic-auth middleware, unchanged from before the discriminated
 * union was introduced. Extracted to a named factory so {@link createAuthMiddleware}
 * can dispatch to it without inlining its body.
 */
const createApiKeyMiddleware = (auth: {
  apiKey?: string;
  apiSecret?: string;
}): Middleware => ({
  async onRequest({ request }) {
    logger.debug({ request }, "Processing request");
    if (auth.apiKey && auth.apiSecret) {
      request.headers.set(
        "Authorization",
        `Basic ${Buffer.from(`${auth.apiKey}:${auth.apiSecret}`).toString("base64")}`,
      );
    } else if (auth.apiKey || auth.apiSecret) {
      const missing = auth.apiKey ? "apiSecret" : "apiKey";
      logger.warn(
        { provided: auth.apiKey ? "apiKey" : "apiSecret", missing },
        `Partial credentials: ${missing} not set. Skipping authentication.`,
      );
    }
    request.headers.set("User-Agent", `mcp-confluent-local/${pkg.version}`);
    return request;
  },
});
