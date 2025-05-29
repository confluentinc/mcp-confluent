import { logger } from "@src/logger.js";
import { Middleware } from "openapi-fetch";

export interface ConfluentEndpoints {
  cloud?: string;
  flink?: string;
  schemaRegistry?: string;
  kafka?: string;
  telemetry?: string;
}

export interface ConfluentAuth {
  apiKey: string;
  apiSecret: string;
}

/**
 * Creates a middleware that adds Authorization header using the provided auth credentials
 */
export const createAuthMiddleware = (auth: ConfluentAuth): Middleware => ({
  async onRequest({ request }) {
    logger.debug({ request }, "Processing request");
    request.headers.set(
      "Authorization",
      `Basic ${Buffer.from(`${auth.apiKey}:${auth.apiSecret}`).toString("base64")}`,
    );
    return request;
  },
});
