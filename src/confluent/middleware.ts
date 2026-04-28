import { logger } from "@src/logger.js";
import { Middleware } from "openapi-fetch";
import pkg from "../../package.json" with { type: "json" };

/**
 * Thrown by the bearer middleware when the token getter returns undefined —
 * typically because OAuth bootstrap has not completed (or has been cleared by
 * shutdown) at the moment a request is being constructed. Carries a clear
 * message; propagates through `BaseToolHandler` into `CallToolResult.isError`.
 */
export class BearerTokenUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BearerTokenUnavailableError";
  }
}

/**
 * Build a {@link Middleware} that attaches `Authorization: Bearer <token>`
 * read from `getToken()`. The closure is supplied by the caller; this
 * middleware has no knowledge of where the token comes from or when it
 * expires. Throws {@link BearerTokenUnavailableError} when `getToken`
 * returns `undefined`.
 */
export const createBearerMiddleware = (
  getToken: () => string | undefined,
): Middleware => ({
  async onRequest({ request }) {
    const token = getToken();
    if (token === undefined) {
      throw new BearerTokenUnavailableError(
        "OAuth token unavailable; the session may have expired. Restart the server to re-authenticate.",
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

export interface ConfluentAuth {
  apiKey?: string;
  apiSecret?: string;
}

/**
 * Creates a middleware that adds Authorization header using the provided auth credentials
 */
export const createAuthMiddleware = (auth: ConfluentAuth): Middleware => ({
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
