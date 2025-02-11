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
export const confluentCloudFlinkAuthMiddleware: Middleware = {
  async onRequest({ request }) {
    console.error(`${JSON.stringify(request)}`);
    // add Authorization header to every request
    request.headers.set(
      "Authorization",
      `Basic ${Buffer.from(`${env.FLINK_API_KEY}:${env.FLINK_API_SECRET}`).toString("base64")}`,
    );
    return request;
  },
};

export const confluentCloudAuthMiddleware: Middleware = {
  async onRequest({ request }) {
    console.error(`${JSON.stringify(request)}`);
    // add Authorization header to every request
    request.headers.set(
      "Authorization",
      `Basic ${Buffer.from(`${env.CONFLUENT_CLOUD_API_KEY}:${env.CONFLUENT_CLOUD_API_SECRET}`).toString("base64")}`,
    );
    return request;
  },
};

export const confluentCloudSchemaRegistryAuthMiddleware: Middleware = {
  async onRequest({ request }) {
    console.error(`${JSON.stringify(request)}`);
    // add Authorization header to every request
    request.headers.set(
      "Authorization",
      `Basic ${Buffer.from(`${env.SCHEMA_REGISTRY_API_KEY}:${env.SCHEMA_REGISTRY_API_SECRET}`).toString("base64")}`,
    );
    return request;
  },
};

export const confluentCloudKafkaAuthMiddleware: Middleware = {
  async onRequest({ request }) {
    console.error(`${JSON.stringify(request)}`);
    // add Authorization header to every request
    request.headers.set(
      "Authorization",
      `Basic ${Buffer.from(`${env.KAFKA_API_KEY}:${env.KAFKA_API_SECRET}`).toString("base64")}`,
    );
    return request;
  },
};
