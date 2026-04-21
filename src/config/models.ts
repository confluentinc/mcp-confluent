import { validateBootstrapServers } from "@src/config/validation.js";
import { z } from "zod";

export interface ApiKeyAuthConfig {
  type: "api_key";
  key: string;
  secret: string;
}

export type AuthConfig = ApiKeyAuthConfig;

/**
 * Connection configuration for a direct (local/Docker) Kafka cluster.
 * At least one of kafka, schema_registry, confluent_cloud, or tableflow must be present.
 */
export interface DirectConnectionConfig {
  type: "direct";
  confluent_cloud?: {
    endpoint?: string;
    auth?: AuthConfig;
  };
  kafka?: {
    bootstrap_servers: string;
    auth?: AuthConfig;
  };
  schema_registry?: {
    endpoint: string;
    auth?: AuthConfig;
  };
  tableflow?: {
    auth?: AuthConfig;
  };
}

/**
 * Union of all connection types (future-proof discriminated union).
 * Currently only supports "direct" type.
 */
export type ConnectionConfig = DirectConnectionConfig;

/**
 * Root configuration object representing the entire MCP server configuration.
 * Validated and constructed from parsed YAML via {@link mcpConfigSchema}.
 */
export class MCPServerConfiguration {
  connections: Record<string, ConnectionConfig>;

  constructor(data: { connections: Record<string, ConnectionConfig> }) {
    this.connections = data.connections;
  }

  /**
   * Returns the single defined connection in the configuration.
   *
   * @returns the single defined connection
   * @throws Error if 0 or more than 1 connection is defined.
   */
  getSoleConnection(): ConnectionConfig {
    const connectionNames = Object.keys(this.connections);
    if (connectionNames.length === 0) {
      throw new Error("No connections defined in configuration");
    }
    if (connectionNames.length > 1) {
      throw new Error(
        "Multiple connections defined in configuration; only one is supported currently",
      );
    }

    // must be exactly one connection at this point, so return it.
    return this.connections[connectionNames[0]!]!;
  }

  getConnectionNames(): string[] {
    return Object.keys(this.connections).sort((a, b) => a.localeCompare(b));
  }
}

/* And now, Zod schemas for validation of MCPServerConfiguration and contained objects. */

const apiKeyAuthSchema = z
  .object({
    type: z.literal("api_key"),
    key: z.string().trim().min(1, "auth.key cannot be empty"),
    secret: z.string().trim().min(1, "auth.secret cannot be empty"),
  })
  .strict();

const authConfigSchema = z.discriminatedUnion("type", [apiKeyAuthSchema]);

/** Zod schema for direct connection type */
const directConnectionSchema = z
  .object({
    type: z.literal("direct"),
    confluent_cloud: z
      .object({
        endpoint: z
          .string()
          .trim()
          .check(
            z.url({ error: "confluent_cloud.endpoint must be a valid URL" }),
          )
          .optional(),
        auth: authConfigSchema.optional(),
      })
      .strict()
      .refine((cc) => cc.endpoint !== undefined || cc.auth !== undefined, {
        message:
          "confluent_cloud block must contain at least 'endpoint' or 'auth'",
      })
      .optional(),
    kafka: z
      .object({
        bootstrap_servers: z
          .string()
          .trim()
          .min(1, "bootstrap_servers cannot be empty")
          .superRefine((value, ctx) => {
            try {
              validateBootstrapServers(value);
            } catch (error) {
              ctx.addIssue({
                code: "custom",
                message: error instanceof Error ? error.message : String(error),
              });
            }
          }),
        auth: authConfigSchema.optional(),
      })
      .strict()
      .optional(),
    schema_registry: z
      .object({
        endpoint: z
          .string()
          .trim()
          .check(
            z.url({ error: "schema_registry.endpoint must be a valid URL" }),
          ),
        auth: authConfigSchema.optional(),
      })
      .strict()
      .optional(),
    tableflow: z
      .object({
        auth: authConfigSchema.optional(),
      })
      .strict()
      .refine((tf) => tf.auth !== undefined, {
        message: "tableflow block must contain 'auth'",
      })
      .optional(),
  })
  .strict();

/**
 * Discriminated union of all connection types (currently just direct).
 */
const connectionConfigSchema = z
  .discriminatedUnion("type", [directConnectionSchema])
  // superRefine is placed here (after the union) rather than on directConnectionSchema
  // because wrapping a ZodObject in ZodEffects breaks z.discriminatedUnion's discriminant lookup.
  .superRefine((data, ctx) => {
    if (
      data.type === "direct" &&
      !data.kafka &&
      !data.schema_registry &&
      !data.confluent_cloud &&
      !data.tableflow
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "At least one of 'kafka', 'schema_registry', 'confluent_cloud', or 'tableflow' must be defined",
      });
    }
  });

/**
 * Root configuration schema.
 *
 * Parsed output is wrapped in {@link MCPServerConfiguration} by
 * parseYamlConfiguration().
 */
export const mcpConfigSchema = z
  .object({
    connections: z
      .record(
        z.string().trim().min(1, "Connection name cannot be empty"),
        connectionConfigSchema,
      )
      .refine(
        (connections) => Object.keys(connections).length === 1,
        "Exactly one connection must be defined (multiple connections not yet supported)",
      ),
  })
  .strict();

/** Format Zod issues into a human-readable string */
export function formatZodIssues(issues: z.ZodError["issues"]): string {
  return issues
    .map((issue) => {
      const path = issue.path.join(".");
      return path ? `  - ${path}: ${issue.message}` : `  - ${issue.message}`;
    })
    .join("\n");
}
