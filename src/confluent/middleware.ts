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
    // use appropriate api key and api secret from env based on the request url
    let apiKey = env.FLINK_API_KEY;
    let apiSecret = env.FLINK_API_SECRET;
    if (request.url.startsWith(env.CONFLUENT_CLOUD_REST_ENDPOINT)) {
      apiKey = env.CONFLUENT_CLOUD_API_KEY;
      apiSecret = env.CONFLUENT_CLOUD_API_SECRET;
    }
    // add Authorization header to every request
    request.headers.set(
      "Authorization",
      `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`,
    );
    return request;
  },
};
