import {
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
  // Schema Registry connection parameters
  SCHEMA_REGISTRY_ENDPOINT: `${CONN}.schema_registry.endpoint`,
  SCHEMA_REGISTRY_API_KEY: `${CONN}.schema_registry.auth.key`,
  SCHEMA_REGISTRY_API_SECRET: `${CONN}.schema_registry.auth.secret`,
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

  if (env.BOOTSTRAP_SERVERS || env.KAFKA_API_KEY || env.KAFKA_API_SECRET) {
    const kafka: Record<string, unknown> = {};
    if (env.BOOTSTRAP_SERVERS) kafka.bootstrap_servers = env.BOOTSTRAP_SERVERS;
    if (env.KAFKA_API_KEY || env.KAFKA_API_SECRET) {
      kafka.auth = {
        type: "api_key",
        key: env.KAFKA_API_KEY,
        secret: env.KAFKA_API_SECRET,
      };
    }
    connection.kafka = kafka;
  }

  if (
    env.SCHEMA_REGISTRY_ENDPOINT ||
    env.SCHEMA_REGISTRY_API_KEY ||
    env.SCHEMA_REGISTRY_API_SECRET
  ) {
    const sr: Record<string, unknown> = {};
    if (env.SCHEMA_REGISTRY_ENDPOINT)
      sr.endpoint = env.SCHEMA_REGISTRY_ENDPOINT;
    if (env.SCHEMA_REGISTRY_API_KEY || env.SCHEMA_REGISTRY_API_SECRET) {
      sr.auth = {
        type: "api_key",
        key: env.SCHEMA_REGISTRY_API_KEY,
        secret: env.SCHEMA_REGISTRY_API_SECRET,
      };
    }
    connection.schema_registry = sr;
  }

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
