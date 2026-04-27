import {
  type AuthConfig,
  type KafkaDirectConfig,
  formatZodIssues,
  mcpConfigSchema,
  MCPServerConfiguration,
} from "@src/config/models.js";
import type { Environment } from "@src/env.js";
import { type KeyValuePairObject } from "properties-file";

const ENV_CONNECTION_NAME = "env-connection";

/** The manufactured document path prefix for the single connection configured from env vars. */
const CONN = `connections.${ENV_CONNECTION_NAME}`;

/**
 * Maps each environment variable in type Environment (and handled by buildConfigFromEnvAndCli)
 * to its corresponding Zod document path in the manufactured MCPServerConfiguration.
 */
const ENV_VAR_TO_ZPATH = {
  // Kafka connection parameters
  BOOTSTRAP_SERVERS: `${CONN}.kafka.bootstrap_servers`,
  KAFKA_API_KEY: `${CONN}.kafka.auth.key`,
  KAFKA_API_SECRET: `${CONN}.kafka.auth.secret`,
  KAFKA_REST_ENDPOINT: `${CONN}.kafka.rest_endpoint`,
  KAFKA_CLUSTER_ID: `${CONN}.kafka.cluster_id`,
  KAFKA_ENV_ID: `${CONN}.kafka.env_id`,
  // Schema Registry connection parameters
  SCHEMA_REGISTRY_ENDPOINT: `${CONN}.schema_registry.endpoint`,
  SCHEMA_REGISTRY_API_KEY: `${CONN}.schema_registry.auth.key`,
  SCHEMA_REGISTRY_API_SECRET: `${CONN}.schema_registry.auth.secret`,
  // Confluent Cloud control plane parameters
  CONFLUENT_CLOUD_REST_ENDPOINT: `${CONN}.confluent_cloud.endpoint`,
  CONFLUENT_CLOUD_API_KEY: `${CONN}.confluent_cloud.auth.key`,
  CONFLUENT_CLOUD_API_SECRET: `${CONN}.confluent_cloud.auth.secret`,
  // Tableflow parameters
  TABLEFLOW_API_KEY: `${CONN}.tableflow.auth.key`,
  TABLEFLOW_API_SECRET: `${CONN}.tableflow.auth.secret`,
  // Flink parameters
  FLINK_REST_ENDPOINT: `${CONN}.flink.endpoint`,
  FLINK_API_KEY: `${CONN}.flink.auth.key`,
  FLINK_API_SECRET: `${CONN}.flink.auth.secret`,
  FLINK_ENV_ID: `${CONN}.flink.environment_id`,
  FLINK_ORG_ID: `${CONN}.flink.organization_id`,
  FLINK_COMPUTE_POOL_ID: `${CONN}.flink.compute_pool_id`,
  FLINK_ENV_NAME: `${CONN}.flink.environment_name`,
  FLINK_DATABASE_NAME: `${CONN}.flink.database_name`,
  // Telemetry parameters
  TELEMETRY_ENDPOINT: `${CONN}.telemetry.endpoint`,
  TELEMETRY_API_KEY: `${CONN}.telemetry.auth.key`,
  TELEMETRY_API_SECRET: `${CONN}.telemetry.auth.secret`,
  // Server configuration
  LOG_LEVEL: "server.log_level",
  HTTP_PORT: "server.http.port",
  HTTP_HOST: "server.http.host",
  HTTP_MCP_ENDPOINT_PATH: "server.http.mcp_endpoint",
  SSE_MCP_ENDPOINT_PATH: "server.http.sse_endpoint",
  SSE_MCP_MESSAGE_ENDPOINT_PATH: "server.http.sse_message_endpoint",
  MCP_API_KEY: "server.auth.api_key",
  MCP_AUTH_DISABLED: "server.auth.disabled",
  MCP_ALLOWED_HOSTS: "server.auth.allowed_hosts",
  DO_NOT_TRACK: "server.do_not_track",
} satisfies Record<keyof Environment, string>;

/**
 * Constructs a single-direct-connection MCPServerConfiguration from environment variables.
 *
 * This is peer to the functionality provided by loadConfigFromYaml(), but for users
 * who want to configure the server solely via (legacy) environment variables. Called when
 * no YAML config file is provided via CLI args.
 *
 * @returns MCPServerConfiguration with a single connection constructed from an Environment object
 * @throws Error if required environment variables are missing or if validation fails
 */
function buildConfigFromEnv(
  env: Environment,
  authOverrides: Pick<EnvPathCliOverrides, "disableAuth" | "allowedHosts"> = {},
): MCPServerConfiguration {
  const connection: Record<string, unknown> = { type: "direct" };

  // Each connection builder returns { <blockKey>: { ...fields } } or null — the key is owned
  // by the builder, not the caller. See builder docstrings for the env vars each handles.
  const connectionBuilders = [
    buildKafkaBlock,
    buildSchemaRegistryBlock,
    buildConfluentCloudBlock,
    buildTableflowBlock,
    buildTelemetryBlock,
    buildFlinkBlock,
  ];

  for (const build of connectionBuilders) {
    const result = build(env);
    if (result) Object.assign(connection, result);
  }

  // Build root document with both the connection and the server block.
  // authOverrides are folded in here so Zod validates the final combined state,
  // including the disabled+api_key mutual exclusion refine.
  const rawDocument: Record<string, unknown> = {
    connections: { [ENV_CONNECTION_NAME]: connection },
    ...buildServerBlock(env, authOverrides),
  };

  // Validate the manufactured config object against the schema, as if it were loaded from a YAML file.
  //
  // (We do this inline here so that we can reverse project any validation errors back into the
  // env var space in the catch block, which we would not be able to do if we deferred validation
  // to a single codepath shared with YAML-loaded configs.)
  const result = mcpConfigSchema.safeParse(rawDocument);

  if (!result.success) {
    const formattedIssues = humanizeEnvConfigPaths(
      formatZodIssues(result.error.issues),
    );
    throw new Error(
      `Failed to construct MCPServerConfiguration from environment variables:\n${formattedIssues}`,
    );
  }

  return new MCPServerConfiguration(result.data);
}

/** CLI flags that may override values in the env-var config path. Mutually exclusive with --config (YAML path). */
export interface EnvPathCliOverrides {
  disableAuth?: boolean;
  allowedHosts?: string[];
  kafkaConfig?: KeyValuePairObject;
}

/**
 * Constructs a fully-resolved MCPServerConfiguration from environment variables and optional
 * CLI flag overrides. Extends {@link buildConfigFromEnv} by folding in the three CLI flags that
 * are only valid on the env-var path (`--disable-auth`, `--allowed-hosts`, `--kafka-config-file`),
 * so that the returned config needs no further patching by the caller.
 *
 * @param env - Environment variables (same contract as {@link buildConfigFromEnv})
 * @param overrides - CLI flag values to merge on top of the env-var-derived config
 */
export function buildConfigFromEnvAndCli(
  env: Environment,
  overrides: EnvPathCliOverrides = {},
): MCPServerConfiguration {
  const config = buildConfigFromEnv(env, {
    disableAuth: overrides.disableAuth,
    allowedHosts: overrides.allowedHosts,
  });
  if (overrides.kafkaConfig)
    config.setKafkaExtraProperties(overrides.kafkaConfig);
  return config;
}

/**
 * Builds the `kafka` connection block from env vars. Triggered when any Kafka-related
 * env var is set. All fields are optional; at least one connectivity field
 * (bootstrap_servers, rest_endpoint, cluster_id, or env_id) is required by the schema.
 *
 * Equivalent YAML:
 *
 * kafka:
 *   bootstrap_servers: "${BOOTSTRAP_SERVERS}"
 *   rest_endpoint: "${KAFKA_REST_ENDPOINT}"
 *   cluster_id: "${KAFKA_CLUSTER_ID}"
 *   env_id: "${KAFKA_ENV_ID}"
 *   auth:
 *     type: api_key
 *     key: "${KAFKA_API_KEY}"
 *     secret: "${KAFKA_API_SECRET}"
 */
function buildKafkaBlock(
  env: Environment,
): { kafka: KafkaDirectConfig } | null {
  if (
    !env.BOOTSTRAP_SERVERS &&
    !env.KAFKA_API_KEY &&
    !env.KAFKA_API_SECRET &&
    !env.KAFKA_REST_ENDPOINT &&
    !env.KAFKA_CLUSTER_ID &&
    !env.KAFKA_ENV_ID
  )
    return null;

  return {
    kafka: {
      ...(env.BOOTSTRAP_SERVERS && {
        bootstrap_servers: env.BOOTSTRAP_SERVERS,
      }),
      ...apiKeyAuth(env.KAFKA_API_KEY, env.KAFKA_API_SECRET),
      ...(env.KAFKA_REST_ENDPOINT && {
        rest_endpoint: env.KAFKA_REST_ENDPOINT,
      }),
      ...(env.KAFKA_CLUSTER_ID && { cluster_id: env.KAFKA_CLUSTER_ID }),
      ...(env.KAFKA_ENV_ID && { env_id: env.KAFKA_ENV_ID }),
    },
  };
}

/**
 * Builds the `schema_registry` connection block from env vars. Triggered when any
 * Schema Registry env var is set.
 *
 * Equivalent YAML:
 *
 * schema_registry:
 *   endpoint: "${SCHEMA_REGISTRY_ENDPOINT}"
 *   auth:
 *     type: api_key
 *     key: "${SCHEMA_REGISTRY_API_KEY}"
 *     secret: "${SCHEMA_REGISTRY_API_SECRET}"
 *
 * Returns a looser object than SchemaRegistryDirectConfig so that Zod will be able
 * to make the complaint that endpoint is required if only the auth var(s) are set.
 */
function buildSchemaRegistryBlock(
  env: Environment,
): { schema_registry: { endpoint?: string; auth?: AuthConfig } } | null {
  if (
    !env.SCHEMA_REGISTRY_ENDPOINT &&
    !env.SCHEMA_REGISTRY_API_KEY &&
    !env.SCHEMA_REGISTRY_API_SECRET
  )
    return null;
  return {
    schema_registry: {
      ...(env.SCHEMA_REGISTRY_ENDPOINT && {
        endpoint: env.SCHEMA_REGISTRY_ENDPOINT,
      }),
      ...apiKeyAuth(
        env.SCHEMA_REGISTRY_API_KEY,
        env.SCHEMA_REGISTRY_API_SECRET,
      ),
    },
  };
}

/**
 * Builds the `confluent_cloud` connection block from env vars. Triggered when at least
 * one of CONFLUENT_CLOUD_API_KEY or CONFLUENT_CLOUD_API_SECRET is set. CONFLUENT_CLOUD_REST_ENDPOINT
 * alone is not sufficient — an endpoint without credentials is ignored.
 *
 * Equivalent YAML:
 *
 * confluent_cloud:
 *   endpoint: "${CONFLUENT_CLOUD_REST_ENDPOINT}"
 *   auth:
 *     type: api_key
 *     key: "${CONFLUENT_CLOUD_API_KEY}"
 *     secret: "${CONFLUENT_CLOUD_API_SECRET}"
 */
function buildConfluentCloudBlock(env: Environment) {
  if (!env.CONFLUENT_CLOUD_API_KEY && !env.CONFLUENT_CLOUD_API_SECRET)
    return null;
  return {
    confluent_cloud: {
      ...(env.CONFLUENT_CLOUD_REST_ENDPOINT && {
        endpoint: env.CONFLUENT_CLOUD_REST_ENDPOINT,
      }),
      ...apiKeyAuth(
        env.CONFLUENT_CLOUD_API_KEY,
        env.CONFLUENT_CLOUD_API_SECRET,
      ),
    },
  };
}

/**
 * Builds the `tableflow` connection block from env vars. Triggered when either
 * Tableflow credential env var is set.
 *
 * Equivalent YAML:
 *
 * tableflow:
 *   auth:
 *     type: api_key
 *     key: "${TABLEFLOW_API_KEY}"
 *     secret: "${TABLEFLOW_API_SECRET}"
 */
function buildTableflowBlock(env: Environment) {
  if (!env.TABLEFLOW_API_KEY && !env.TABLEFLOW_API_SECRET) return null;
  return {
    tableflow: apiKeyAuth(env.TABLEFLOW_API_KEY, env.TABLEFLOW_API_SECRET),
  };
}

/**
 * Builds the `telemetry` connection block from env vars. Triggered when any telemetry
 * env var is set.
 *
 * Equivalent YAML:
 *
 * telemetry:
 *   endpoint: "${TELEMETRY_ENDPOINT}"
 *   auth:
 *     type: api_key
 *     key: "${TELEMETRY_API_KEY}"
 *     secret: "${TELEMETRY_API_SECRET}"
 */
function buildTelemetryBlock(
  env: Environment,
): { telemetry: { endpoint?: string; auth?: AuthConfig } } | null {
  if (
    !env.TELEMETRY_ENDPOINT &&
    !env.TELEMETRY_API_KEY &&
    !env.TELEMETRY_API_SECRET
  )
    return null;
  return {
    telemetry: {
      ...(env.TELEMETRY_ENDPOINT && { endpoint: env.TELEMETRY_ENDPOINT }),
      ...apiKeyAuth(env.TELEMETRY_API_KEY, env.TELEMETRY_API_SECRET),
    },
  };
}

/**
 * Builds the `flink` connection block from env vars. Triggered when any Flink env var
 * is set. Returns a looser object than FlinkDirectConfig so that Zod will be able
 * to make the complaint that endpoint, auth, environment_id, organization_id, and
 * compute_pool_id are required if only some fields are set.
 *
 * Equivalent YAML:
 *
 * flink:
 *   endpoint: "${FLINK_REST_ENDPOINT}"
 *   environment_id: "${FLINK_ENV_ID}"
 *   organization_id: "${FLINK_ORG_ID}"
 *   compute_pool_id: "${FLINK_COMPUTE_POOL_ID}"
 *   environment_name: "${FLINK_ENV_NAME}"
 *   database_name: "${FLINK_DATABASE_NAME}"
 *   auth:
 *     type: api_key
 *     key: "${FLINK_API_KEY}"
 *     secret: "${FLINK_API_SECRET}"
 */
function buildFlinkBlock(env: Environment): {
  flink: {
    endpoint?: string;
    auth?: AuthConfig;
    environment_id?: string;
    organization_id?: string;
    compute_pool_id?: string;
    environment_name?: string;
    database_name?: string;
  };
} | null {
  if (
    !env.FLINK_REST_ENDPOINT &&
    !env.FLINK_API_KEY &&
    !env.FLINK_API_SECRET &&
    !env.FLINK_ENV_ID &&
    !env.FLINK_ORG_ID &&
    !env.FLINK_COMPUTE_POOL_ID &&
    !env.FLINK_ENV_NAME &&
    !env.FLINK_DATABASE_NAME
  )
    return null;
  return {
    flink: {
      ...(env.FLINK_REST_ENDPOINT && { endpoint: env.FLINK_REST_ENDPOINT }),
      ...apiKeyAuth(env.FLINK_API_KEY, env.FLINK_API_SECRET),
      ...(env.FLINK_ENV_ID && { environment_id: env.FLINK_ENV_ID }),
      ...(env.FLINK_ORG_ID && { organization_id: env.FLINK_ORG_ID }),
      ...(env.FLINK_COMPUTE_POOL_ID && {
        compute_pool_id: env.FLINK_COMPUTE_POOL_ID,
      }),
      ...(env.FLINK_ENV_NAME && { environment_name: env.FLINK_ENV_NAME }),
      ...(env.FLINK_DATABASE_NAME && {
        database_name: env.FLINK_DATABASE_NAME,
      }),
    },
  };
}

/**
 * Builds the root-level `server` block from env vars. Always returns a block —
 * all fields have defaults in envSchema so they are always present after initEnv().
 *
 * Equivalent YAML:
 *
 * server:
 *   log_level: "${LOG_LEVEL}"
 *   http:
 *     port: ${HTTP_PORT}
 *     host: "${HTTP_HOST}"
 *     mcp_endpoint: "${HTTP_MCP_ENDPOINT_PATH}"
 *     sse_endpoint: "${SSE_MCP_ENDPOINT_PATH}"
 *     sse_message_endpoint: "${SSE_MCP_MESSAGE_ENDPOINT_PATH}"
 *   do_not_track: ${DO_NOT_TRACK}
 *   auth:
 *     api_key: "${MCP_API_KEY}"       # omitted when not set
 *     disabled: ${MCP_AUTH_DISABLED}
 *     allowed_hosts: ${MCP_ALLOWED_HOSTS}
 */
function buildServerBlock(
  env: Environment,
  authOverrides: Pick<EnvPathCliOverrides, "disableAuth" | "allowedHosts"> = {},
): { server: Record<string, unknown> } {
  return {
    server: {
      log_level: env.LOG_LEVEL,
      do_not_track: env.DO_NOT_TRACK,
      http: {
        port: env.HTTP_PORT,
        host: env.HTTP_HOST,
        mcp_endpoint: env.HTTP_MCP_ENDPOINT_PATH,
        sse_endpoint: env.SSE_MCP_ENDPOINT_PATH,
        sse_message_endpoint: env.SSE_MCP_MESSAGE_ENDPOINT_PATH,
      },
      auth: {
        ...(env.MCP_API_KEY !== undefined && { api_key: env.MCP_API_KEY }),
        disabled: authOverrides.disableAuth ?? env.MCP_AUTH_DISABLED,
        allowed_hosts: authOverrides.allowedHosts ?? env.MCP_ALLOWED_HOSTS,
      },
    },
  };
}

/** Returns an `{ auth: ... }` spread object when either credential is present, empty object otherwise. */
function apiKeyAuth(
  key: string | undefined,
  secret: string | undefined,
): { auth?: AuthConfig } {
  if (!key && !secret) return {};
  // Non-null assertions: Zod validates that both are actually present and non-empty.
  return { auth: { type: "api_key", key: key!, secret: secret! } };
}

/**
 * Replaces Zod document path segments in a formatted error string with their
 * corresponding environment variable names, translating schema-space errors
 * back into the env-var space the user configured.
 */
function humanizeEnvConfigPaths(message: string): string {
  return Object.entries(ENV_VAR_TO_ZPATH).reduce(
    (msg, [envVar, zodPath]) => msg.replaceAll(zodPath, envVar),
    message,
  );
}
