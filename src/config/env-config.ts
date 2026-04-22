import {
  type AuthConfig,
  type ConfluentCloudDirectConfig,
  type KafkaDirectConfig,
  type TableflowDirectConfig,
  type TelemetryDirectConfig,
  formatZodIssues,
  mcpConfigSchema,
  MCPServerConfiguration,
} from "@src/config/models.js";
import type { Environment } from "@src/env.js";

const ENV_CONNECTION_NAME = "env-connection";

/** The manufactured document path prefix for the single connection configured from env vars. */
const CONN = `connections.${ENV_CONNECTION_NAME}`;

/**
 * Maps each environment variable name handled by consConfigFromEnv to its
 * corresponding Zod document path in the manufactured MCPServerConfiguration.
 * The keys drive the Pick<Environment, ...> type of consConfigFromEnv, so every
 * env var the function touches must have an entry here.
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
} satisfies Partial<Record<keyof Environment, string>>;

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
export function consConfigFromEnv(
  env: Pick<Environment, keyof typeof ENV_VAR_TO_ZPATH>,
): MCPServerConfiguration {
  const connection: Record<string, unknown> = { type: "direct" };

  // Each builder returns { <blockKey>: { ...fields } } or null — the key is owned
  // by the builder, not the caller. See builder docstrings for the env vars each handles.
  const builders = [
    buildKafkaBlock,
    buildSchemaRegistryBlock,
    buildConfluentCloudBlock,
    buildTableflowBlock,
    buildTelemetryBlock,
    buildFlinkBlock,
  ];

  for (const build of builders) {
    const result = build(env);
    if (result) Object.assign(connection, result);
  }

  // Validate the manufactured config object against the schema, as if it were loaded from a YAML file.
  //
  // (We do this inline here so that we can reverse project any validation errors back into the
  // env var space in the catch block, which we would not be able to do if we deferred validation
  // to a single codepath shared with YAML-loaded configs.)
  const result = mcpConfigSchema.safeParse({
    connections: { [ENV_CONNECTION_NAME]: connection },
  });

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

type EnvSubset = Pick<Environment, keyof typeof ENV_VAR_TO_ZPATH>;

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
function buildKafkaBlock(env: EnvSubset): { kafka: KafkaDirectConfig } | null {
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
  env: EnvSubset,
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
 * Builds the `confluent_cloud` connection block from env vars. Triggered when any
 * Confluent Cloud control-plane env var is set.
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
function buildConfluentCloudBlock(
  env: EnvSubset,
): { confluent_cloud: ConfluentCloudDirectConfig } | null {
  if (
    !env.CONFLUENT_CLOUD_REST_ENDPOINT &&
    !env.CONFLUENT_CLOUD_API_KEY &&
    !env.CONFLUENT_CLOUD_API_SECRET
  )
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
function buildTableflowBlock(
  env: EnvSubset,
): { tableflow: TableflowDirectConfig } | null {
  if (!env.TABLEFLOW_API_KEY && !env.TABLEFLOW_API_SECRET) return null;
  return {
    tableflow: apiKeyAuth(env.TABLEFLOW_API_KEY, env.TABLEFLOW_API_SECRET),
  };
}

/**
 * Builds the `telemetry` connection block from env vars. Triggered when any telemetry
 * env var is set. Auth falls back to Confluent Cloud credentials at runtime if omitted.
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
  env: EnvSubset,
): { telemetry: TelemetryDirectConfig } | null {
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
function buildFlinkBlock(env: EnvSubset): {
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
