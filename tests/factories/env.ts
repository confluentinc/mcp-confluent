import type { Environment } from "@src/env.js";

const BASE_ENV: Environment = {
  // envSchema fields — use Zod defaults
  HTTP_PORT: 8080,
  HTTP_HOST: "127.0.0.1",
  HTTP_MCP_ENDPOINT_PATH: "/mcp",
  SSE_MCP_ENDPOINT_PATH: "/sse",
  SSE_MCP_MESSAGE_ENDPOINT_PATH: "/messages",
  LOG_LEVEL: "info",
  MCP_AUTH_DISABLED: false,
  DO_NOT_TRACK: false,
  MCP_ALLOWED_HOSTS: ["localhost", "127.0.0.1"],
  // configSchema fields with defaults
  CONFLUENT_CLOUD_REST_ENDPOINT: "https://api.confluent.cloud",
  TELEMETRY_ENDPOINT: "https://api.telemetry.confluent.cloud",
  // All credential / endpoint / runtime-config fields: absent
  MCP_API_KEY: undefined,
  BOOTSTRAP_SERVERS: undefined,
  KAFKA_API_KEY: undefined,
  KAFKA_API_SECRET: undefined,
  FLINK_API_KEY: undefined,
  FLINK_API_SECRET: undefined,
  CONFLUENT_CLOUD_API_KEY: undefined,
  CONFLUENT_CLOUD_API_SECRET: undefined,
  SCHEMA_REGISTRY_API_KEY: undefined,
  SCHEMA_REGISTRY_API_SECRET: undefined,
  TABLEFLOW_API_KEY: undefined,
  TABLEFLOW_API_SECRET: undefined,
  FLINK_REST_ENDPOINT: undefined,
  SCHEMA_REGISTRY_ENDPOINT: undefined,
  KAFKA_REST_ENDPOINT: undefined,
  TELEMETRY_API_KEY: undefined,
  TELEMETRY_API_SECRET: undefined,
  FLINK_ENV_ID: undefined,
  FLINK_ORG_ID: undefined,
  FLINK_COMPUTE_POOL_ID: undefined,
  FLINK_ENV_NAME: undefined,
  FLINK_DATABASE_NAME: undefined,
  KAFKA_CLUSTER_ID: undefined,
  KAFKA_ENV_ID: undefined,
};

/**
 * Constructs a minimal valid {@link Environment} for use in tests.
 * All credential and endpoint fields default to `undefined` (tool disabled).
 * Pass overrides to selectively satisfy the env vars required by specific tools.
 */
export function envFactory(overrides: Partial<Environment> = {}): Environment {
  return { ...BASE_ENV, ...overrides };
}
