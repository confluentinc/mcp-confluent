import { validateBootstrapServers } from "@src/config/validation.js";
import { z } from "zod";

/**
 * Connection configuration for a direct (local/Docker) Kafka cluster.
 * At least one of kafka, schema_registry, confluent_cloud, tableflow, flink, or telemetry must be present.
 */
export interface DirectConnectionConfig {
  type: "direct";
  kafka?: KafkaDirectConfig;
  schema_registry?: SchemaRegistryDirectConfig;
  confluent_cloud?: ConfluentCloudDirectConfig;
  tableflow?: TableflowDirectConfig;
  telemetry?: TelemetryDirectConfig;
  flink?: FlinkDirectConfig;
}

/** Subcomponent of various parts of DirectConnectionConfig */
export interface ApiKeyAuthConfig {
  type: "api_key";
  key: string;
  secret: string;
}

export type AuthConfig = ApiKeyAuthConfig;

/** Subcomponent of DirectConnectionConfig describing Kafka connection parameters */
export interface KafkaDirectConfig {
  bootstrap_servers?: string;
  auth?: AuthConfig;
  rest_endpoint?: string;
  cluster_id?: string;
  env_id?: string;
  extra_properties?: Record<string, string>;
}

/** Subcomponent of DirectConnectionConfig describing Schema Registry connection parameters */
export interface SchemaRegistryDirectConfig {
  endpoint: string;
  auth?: AuthConfig;
}

/** Subcomponent of DirectConnectionConfig describing Confluent Cloud connection parameters */
export interface ConfluentCloudDirectConfig {
  endpoint?: string;
  auth?: AuthConfig;
}

/** Subcomponent of DirectConnectionConfig describing Tableflow connection parameters */
export interface TableflowDirectConfig {
  auth?: AuthConfig;
}

/** Subcomponent of DirectConnectionConfig describing Telemetry connection parameters */
export interface TelemetryDirectConfig {
  endpoint?: string;
  auth?: AuthConfig;
}

/** Subcomponent of DirectConnectionConfig describing Flink connection parameters */
export interface FlinkDirectConfig {
  endpoint: string;
  auth: AuthConfig;
  environment_id: string;
  organization_id: string;
  compute_pool_id: string;
  environment_name?: string;
  database_name?: string;
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

  /**
   * Absorbs `-k` / `--kafka-config-file` properties into the kafka block so that all
   * config is consolidated in MCPServerConfiguration before client construction.
   *
   * Only valid in the legacy env-var codepath (`consConfigFromEnv`). YAML-configured
   * connections must not use this method — the `--config` and `--kafka-config-file` flags
   * are mutually exclusive and enforced at CLI parse time.
   *
   * Protected keys (`bootstrap.servers`, `sasl.username`, `sasl.password`) are always
   * promoted into their corresponding named fields, overriding any env-var-derived values
   * already present. All other keys go into `extra_properties`. This ensures the resulting
   * MCPServerConfiguration is self-consistent: named fields hold the authoritative values
   * with CLI arguments taking precedence over environment variables, matching the intended
   * precedence order.
   *
   * Creates a kafka block if none exists, so that `-k` alone (without any Kafka env vars)
   * is sufficient to configure the client.
   *
   * Throws if `extra_properties` is already set — guards against double-application.
   */
  setKafkaExtraProperties(props: Record<string, string>): void {
    const conn = this.getSoleConnection();

    if (!conn.kafka) {
      conn.kafka = {};
    }

    if (conn.kafka.extra_properties !== undefined) {
      throw new Error(
        "Cannot apply --kafka-config-file: kafka.extra_properties is already defined in configuration",
      );
    }

    const hasSaslUser = !!props["sasl.username"];
    const hasSaslPass = !!props["sasl.password"];
    if (hasSaslUser !== hasSaslPass) {
      throw new Error(
        "--kafka-config-file: sasl.username and sasl.password must both be present or both be absent",
      );
    }

    const protectedSet = new Set<string>(KAFKA_PROTECTED_EXTRA_PROPERTY_KEYS);

    if (props["bootstrap.servers"]) {
      conn.kafka.bootstrap_servers = props["bootstrap.servers"];
    }
    if (props["sasl.username"] && props["sasl.password"]) {
      conn.kafka.auth = {
        type: "api_key",
        key: props["sasl.username"],
        secret: props["sasl.password"],
      };
    }

    const remaining = Object.fromEntries(
      Object.entries(props).filter(([k]) => !protectedSet.has(k)),
    );
    if (Object.keys(remaining).length > 0) {
      conn.kafka.extra_properties = remaining;
    }
  }
}

/* And now, Zod schemas for validation of MCPServerConfiguration and contained objects. */

/**
 * librdkafka property keys that have named YAML equivalents and must not appear in
 * `extra_properties`. Authoring them there is an error in YAML-configured connections;
 * use `bootstrap_servers` or the `auth` block instead.
 *
 * Note: this restriction applies only to YAML-authored configs. The `-k` /
 * `--kafka-config-file` CLI flag is a higher-precedence override mechanism and is
 * permitted to supply these keys (env vars are always lowest precedence).
 */
export const KAFKA_PROTECTED_EXTRA_PROPERTY_KEYS = [
  "bootstrap.servers",
  "sasl.username",
  "sasl.password",
] as const;

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
          })
          .optional(),
        auth: authConfigSchema.optional(),
        rest_endpoint: z
          .string()
          .trim()
          .check(z.url({ error: "kafka.rest_endpoint must be a valid URL" }))
          .optional(),
        cluster_id: z
          .string()
          .trim()
          .min(1, "kafka.cluster_id cannot be empty")
          .optional(),
        env_id: z
          .string()
          .trim()
          .startsWith("env-", "kafka.env_id must start with 'env-'")
          .optional(),
        extra_properties: z
          .record(z.string(), z.string())
          .superRefine((props, ctx) => {
            const found = KAFKA_PROTECTED_EXTRA_PROPERTY_KEYS.filter(
              (k) => k in props,
            );
            if (found.length > 0) {
              ctx.addIssue({
                code: "custom",
                message: `extra_properties must not include ${found.join(", ")} — use the named YAML fields (bootstrap_servers, auth) instead`,
              });
            }
          })
          .optional(),
      })
      .strict()
      .refine(
        (k) =>
          k.bootstrap_servers !== undefined ||
          k.rest_endpoint !== undefined ||
          k.cluster_id !== undefined ||
          k.env_id !== undefined,
        {
          message:
            "kafka block must contain at least one of 'bootstrap_servers', 'rest_endpoint', 'cluster_id', or 'env_id'",
        },
      )
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
    telemetry: z
      .object({
        endpoint: z
          .string()
          .trim()
          .check(z.url({ error: "telemetry.endpoint must be a valid URL" }))
          .optional(),
        auth: authConfigSchema.optional(),
      })
      .strict()
      .refine((t) => t.endpoint !== undefined || t.auth !== undefined, {
        message: "telemetry block must contain at least 'endpoint' or 'auth'",
      })
      .optional(),
    flink: z
      .object({
        endpoint: z
          .string()
          .trim()
          .check(z.url({ error: "flink.endpoint must be a valid URL" })),
        auth: authConfigSchema,
        environment_id: z
          .string()
          .trim()
          .startsWith("env-", "flink.environment_id must start with 'env-'"),
        organization_id: z
          .string()
          .trim()
          .min(1, "flink.organization_id cannot be empty"),
        compute_pool_id: z
          .string()
          .trim()
          .startsWith("lfcp-", "flink.compute_pool_id must start with 'lfcp-'"),
        environment_name: z
          .string()
          .trim()
          .min(1, "flink.environment_name cannot be empty")
          .optional(),
        database_name: z
          .string()
          .trim()
          .min(1, "flink.database_name cannot be empty")
          .optional(),
      })
      .strict()
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
      !data.tableflow &&
      !data.flink &&
      !data.telemetry
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "At least one of 'kafka', 'schema_registry', 'confluent_cloud', 'tableflow', 'flink', or 'telemetry' must be defined",
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
