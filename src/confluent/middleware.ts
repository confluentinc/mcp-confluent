import env from "@src/env.js";
import { Middleware } from "openapi-fetch";
/**
 * Middleware to add Authorization header to every request.
 *
 * This middleware intercepts each request and adds an Authorization header
 * using the Flink API key and secret from the environment variables.
 *
 * @param {Object} request - The request object.
 * @returns {Object} The modified request object with the Authorization header.
 */
export const authMiddleware: Middleware = {
  async onRequest({ request }) {
    // add Authorization header to every request
    // us flink api key and flink api secret from env
    request.headers.set(
      "Authorization",
      `Basic ${Buffer.from(`${env.FLINK_API_KEY}:${env.FLINK_API_SECRET}`).toString("base64")}`,
    );
    return request;
  },
};
