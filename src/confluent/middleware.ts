import { logger } from "@src/logger.js";
import { Middleware } from "openapi-fetch";
import pkg from "../../package.json" with { type: "json" };

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
