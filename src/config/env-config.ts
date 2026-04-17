import { MCPServerConfiguration, mcpConfigSchema } from "@src/config/models.js";
import type { Environment } from "@src/env.js";

const ENV_CONNECTION_NAME = "env-connection";

/**
 * Constructs a single-direct-connection MCPServerConfiguration from environment variables.
 *
 * Maps BOOTSTRAP_SERVERS → connections[env-connection].kafka.bootstrap_servers
 * and SCHEMA_REGISTRY_ENDPOINT → connections[env-connection].schema_registry.endpoint.
 *
 * This is a peer to the functionality provided by loadConfigFromYaml(), but for users
 * who want to configure the server solely via environment variables. Called when
 * no YAML config file is provided via CLI args.
 *
 * @returns MCPServerConfiguration constructed from environment variables
 * @throws Error if required environment variables are missing or if validation fails
 */
export function consConfigFromEnv(
  env: Pick<Environment, "BOOTSTRAP_SERVERS" | "SCHEMA_REGISTRY_ENDPOINT">,
): MCPServerConfiguration {
  const connection: Record<string, unknown> = { type: "direct" };

  if (env.BOOTSTRAP_SERVERS) {
    connection.kafka = { bootstrap_servers: env.BOOTSTRAP_SERVERS };
  }

  if (env.SCHEMA_REGISTRY_ENDPOINT) {
    connection.schema_registry = { endpoint: env.SCHEMA_REGISTRY_ENDPOINT };
  }

  const result = mcpConfigSchema.safeParse({
    connections: { [ENV_CONNECTION_NAME]: connection },
  });

  if (!result.success) {
    const errors = result.error.issues
      .map((issue) => {
        const path = issue.path.join(".");
        return path ? `  - ${path}: ${issue.message}` : `  - ${issue.message}`;
      })
      .join("\n");
    throw new Error(
      `Failed to construct MCPServerConfiguration from environment variables:\n${errors}`,
    );
  }

  return new MCPServerConfiguration(result.data);
}
