import { validateBootstrapServers } from "@src/config/validation.js";
import { logLevels } from "@src/logger.js";
import { TransportType } from "@src/mcp/transports/types.js";
import { z } from "zod";

// The following interfaces and types define subcomponents of class MCPServerConfiguration, which represents our entire server configuration.
// Each interface corresponds to a specific section of a YAML configuration file, as indicated in the comments, or through
// legacy environment variable or CLI arguments (see buildConfigFromEnvAndCli in src/config/env-config.ts).

// Zod is used for validation and transformation of from-yaml or environment variables into these structured types, with the root schema
// being mcpConfigSchema at the bottom of this file.

/**
 * Connection configuration for a direct (local/Docker/Cloud) Kafka cluster.
 * Corresponds to `connections.<name>` (with `type: direct`) in the YAML configuration.
 * At least one of kafka, schema_registry, confluent_cloud, tableflow, flink, or telemetry must be present.
 */
export interface DirectConnectionConfig {
  readonly type: "direct";
  readonly kafka?: KafkaDirectConfig;
  readonly schema_registry?: SchemaRegistryDirectConfig;
  readonly confluent_cloud?: ConfluentCloudDirectConfig;
  readonly tableflow?: TableflowDirectConfig;
  readonly telemetry?: TelemetryDirectConfig;
  readonly flink?: FlinkDirectConfig;
}

/**
 * Connection-shaped configuration for a Confluent Cloud OAuth (PKCE) connection.
 * Peer to {@link DirectConnectionConfig}. For now this is held as a private
 * optional field on {@link MCPServerConfiguration} (see `#ccloudOAuth`); the
 * connections-record migration moves it into `connections` as a second member
 * of the discriminated `ConnectionConfig` union.
 *
 * Endpoints derive from `env` via the Auth0 environment table — the only data
 * needed to drive the PKCE flow and resolve REST base URLs.
 */
export interface CCloudOAuthConfig {
  readonly type: "ccloud_oauth";
  readonly env: "devel" | "stag" | "prod";
}

/**
 * OAuth (PKCE) connection variant. Peer arm of {@link DirectConnectionConfig}
 * inside the `ConnectionConfig` discriminated union. The CCloud REST URL is
 * derived from `development_env` via `getCloudRestUrlForEnv` inside
 * `OAuthClientManager`. No service blocks; OAuth-eligible tools auto-enable
 * via the `isOAuth` predicate, and resource IDs that direct connections supply
 * via blocks must be passed as tool arguments under OAuth.
 *
 * `development_env` defaults to "prod" via the schema; only Confluent staff
 * testing against devel/stag set it explicitly.
 */
export interface OAuthConnectionConfig {
  readonly type: "oauth";
  readonly development_env: "devel" | "stag" | "prod";
}

/**
 * API key credential pair used throughout connection sub-configs.
 * Corresponds to `auth` blocks nested under each service in `connections.<name>`.
 */
export interface ApiKeyAuthConfig {
  readonly type: "api_key";
  readonly key: string;
  readonly secret: string;
}

export type AuthConfig = ApiKeyAuthConfig;

/**
 * Kafka broker connection parameters.
 * Corresponds to `connections.<name>.kafka` in the YAML configuration.
 */
export interface KafkaDirectConfig {
  readonly bootstrap_servers?: string;
  readonly auth?: AuthConfig;
  readonly rest_endpoint?: string;
  readonly cluster_id?: string;
  readonly env_id?: string;
  readonly extra_properties?: Readonly<Record<string, string>>;
}

/**
 * Schema Registry connection parameters.
 * Corresponds to `connections.<name>.schema_registry` in the YAML configuration.
 */
export interface SchemaRegistryDirectConfig {
  readonly endpoint: string;
  readonly auth?: AuthConfig;
}

/**
 * Confluent Cloud control-plane connection parameters.
 * Corresponds to `connections.<name>.confluent_cloud` in the YAML configuration.
 */
export interface ConfluentCloudDirectConfig {
  readonly endpoint: string;
  readonly auth: AuthConfig;
}

/**
 * Tableflow connection parameters.
 * Corresponds to `connections.<name>.tableflow` in the YAML configuration.
 */
export interface TableflowDirectConfig {
  readonly auth: AuthConfig;
}

/**
 * Telemetry API connection parameters (post-transform output type).
 * Corresponds to `connections.<name>.telemetry` in the YAML configuration.
 */
export interface TelemetryDirectConfig {
  readonly endpoint: string;
  readonly auth: AuthConfig;
}

/**
 * Flink connection parameters.
 * Corresponds to `connections.<name>.flink` in the YAML configuration.
 */
export interface FlinkDirectConfig {
  readonly endpoint: string;
  readonly auth: AuthConfig;
  readonly environment_id: string;
  readonly organization_id: string;
  readonly compute_pool_id: string;
  readonly environment_name?: string;
  readonly database_name?: string;
}

/**
 * Union of all connection types (future-proof discriminated union).
 * Currently only supports "direct" type.
 */
export type ConnectionConfig = DirectConnectionConfig | OAuthConnectionConfig;

/**
 * MCP server operational settings — transport, auth, and logging.
 * Corresponds to the `server` block at the root of the YAML configuration.
 * Distinct from connection config, which governs Kafka and Confluent Cloud client behaviour.
 */
export interface ServerConfig {
  readonly transports: readonly TransportType[];
  readonly log_level: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
  readonly do_not_track: boolean;
  readonly http: ServerHttpConfig;
  readonly auth: ServerAuthConfig;
}

/**
 * HTTP/SSE transport bind address and endpoint paths.
 * Corresponds to `server.http` in the YAML configuration.
 */
export interface ServerHttpConfig {
  readonly port: number;
  readonly host: string;
  readonly mcp_endpoint: string;
  readonly sse_endpoint: string;
  readonly sse_message_endpoint: string;
}

/**
 * HTTP/SSE transport authentication settings.
 * Corresponds to `server.auth` in the YAML configuration.
 * `api_key` and `disabled: true` are mutually exclusive.
 */
export interface ServerAuthConfig {
  readonly api_key?: string;
  readonly disabled: boolean;
  readonly allowed_hosts: readonly string[];
}

/**
 * Root configuration object representing the entire MCP server configuration.
 * Validated and constructed from parsed YAML via {@link mcpConfigSchema}.
 */
export class MCPServerConfiguration {
  /** Named connection map. Corresponds to the `connections` block at the root of the YAML configuration. */
  readonly connections: Readonly<Record<string, ConnectionConfig>>;
  /** MCP server operational settings. Corresponds to the `server` block at the root of the YAML configuration. */
  readonly server: ServerConfig;
  /**
   * CCloud OAuth connection config, when configured via `--oauth` /
   * `--oauth-env` on the env-var pathway. Held outside the `connections`
   * record because the single-connection guard prohibits a second entry;
   * the connections-record migration will move it inside the record and
   * remove both this private field and {@link MCPServerConfiguration.getCCloudOAuth}.
   */
  readonly #ccloudOAuth: CCloudOAuthConfig | undefined;

  constructor(data: {
    connections: Record<string, ConnectionConfig>;
    server?: ServerConfig;
    ccloudOAuth?: CCloudOAuthConfig;
  }) {
    this.connections = data.connections;
    // DEFAULT_SERVER_CONFIG is declared after the schemas below; it is always
    // initialized before any MCPServerConfiguration instance is created at runtime.
    this.server = data.server ?? DEFAULT_SERVER_CONFIG;
    this.#ccloudOAuth = data.ccloudOAuth;
  }

  /**
   * Returns the CCloud OAuth connection config when one was supplied at
   * construction time; `undefined` otherwise. {@link ServerRuntime.fromConfig}
   * uses this to decide whether to bootstrap an `OAuthHolder`.
   */
  getCCloudOAuth(): CCloudOAuthConfig | undefined {
    return this.#ccloudOAuth;
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

  /**
   * Returns the sole connection narrowed to {@link DirectConnectionConfig}, throwing
   * if it is OAuth-typed. Use from callers that need to read service-block fields
   * (e.g., `kafka.cluster_id`, `flink.environment_id`) — the throw replaces what
   * would otherwise be a `conn.type === "direct"` guard at every read site.
   */
  getSoleDirectConnection(): DirectConnectionConfig {
    const conn = this.getSoleConnection();
    if (conn.type !== "direct") {
      throw new Error(
        `Expected sole connection to be a direct connection; got type "${conn.type}"`,
      );
    }
    return conn;
  }

  getConnectionNames(): string[] {
    return Object.keys(this.connections).sort((a, b) => a.localeCompare(b));
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

/**
 * Requires at least one primary connectivity field (`bootstrap_servers` or `rest_endpoint`).
 *
 * (`cluster_id` and `env_id` are intentionally excluded: they are per-call defaults
 * resolved at handler runtime via `getEnsuredParam`, which checks (in order) the tool
 * argument supplied by the LLM, then the env var, then throws. Either field can be
 * omitted from config and supplied at call time, so partial presence is valid.)
 */
function kafkaBlockHasConnectivity(k: {
  bootstrap_servers?: string;
  rest_endpoint?: string;
}): boolean {
  return k.bootstrap_servers !== undefined || k.rest_endpoint !== undefined;
}

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
        auth: authConfigSchema,
      })
      .strict()
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
            const found = KAFKA_PROTECTED_EXTRA_PROPERTY_KEYS.filter((k) =>
              Object.hasOwn(props, k),
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
      .refine(kafkaBlockHasConnectivity, {
        message:
          "kafka block must contain at least one of 'bootstrap_servers' or 'rest_endpoint'",
      })
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
        auth: authConfigSchema,
      })
      .strict()
      .optional(),
    telemetry: z
      .object({
        endpoint: z
          .string()
          .trim()
          .check(z.url({ error: "telemetry.endpoint must be a valid URL" }))
          .optional(),
        // Optional in raw input: absent auth falls back to confluent_cloud.auth in
        // the connection-level transform, so TelemetryDirectConfig.auth is always
        // non-null after parsing. See the transform below and TelemetryDirectConfig.
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

export const CONFLUENT_CLOUD_DEFAULT_ENDPOINT = "https://api.confluent.cloud";
const TELEMETRY_DEFAULT_ENDPOINT = "https://api.telemetry.confluent.cloud";

/** Zod schema for the OAuth (PKCE) connection arm. */
const oauthConnectionSchema = z
  .object({
    type: z.literal("oauth"),
    development_env: z.enum(["devel", "stag", "prod"]).default("prod"),
  })
  .strict();

/**
 * Discriminated union of all connection types: direct (api-key) and oauth (PKCE).
 */
const connectionConfigSchema = z
  .discriminatedUnion("type", [directConnectionSchema, oauthConnectionSchema])
  // superRefine calls are placed here (after the union) rather than on directConnectionSchema
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
  })
  .superRefine((data, ctx) => {
    // Reject endpoint-only telemetry when there is no auth available from either
    // telemetry.auth or the confluent_cloud.auth fallback. Without this check the
    // transform below would pass undefined to the ! assertion on auth, producing a
    // TelemetryDirectConfig with auth set to undefined at runtime despite the type.
    if (
      data.type === "direct" &&
      data.telemetry?.endpoint !== undefined &&
      data.telemetry?.auth === undefined &&
      data.confluent_cloud?.auth === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["telemetry", "endpoint"],
        message:
          "telemetry.endpoint is set but no auth is available — provide telemetry.auth or confluent_cloud.auth",
      });
    }
  })
  .transform((data): ConnectionConfig => {
    // OAuth connections carry no service blocks — pass through untouched so the
    // direct-arm telemetry/cc resolution below doesn't spread `undefined` onto them.
    if (data.type !== "direct") return data;
    // Resolve the raw (optional-field) telemetry input into a fully-populated
    // TelemetryDirectConfig or undefined, applying two normalisation rules:
    //   1. If telemetry.auth is absent, fall back to confluent_cloud.auth.
    //   2. If telemetry.endpoint is absent, default to TELEMETRY_DEFAULT_ENDPOINT.
    // If no telemetry block exists but confluent_cloud.auth is present, synthesise
    // a telemetry block from it so callers never need to repeat the fallback logic.
    const rawTelemetry = data.telemetry;
    const ccAuth = data.confluent_cloud?.auth;
    let resolvedTelemetry: TelemetryDirectConfig | undefined;

    if (rawTelemetry) {
      // superRefine above guarantees auth is non-null: endpoint-only telemetry without
      // any auth fallback is rejected before this transform runs.
      // Post-condition: resolvedTelemetry.auth is always non-null — hasTelemetry() is
      // sufficient to gate telemetry-dependent tools; a separate auth check is redundant.
      const auth = (rawTelemetry.auth ?? ccAuth)!;
      const endpoint = rawTelemetry.endpoint ?? TELEMETRY_DEFAULT_ENDPOINT;
      resolvedTelemetry = { endpoint, auth };
    } else if (ccAuth) {
      resolvedTelemetry = {
        endpoint: TELEMETRY_DEFAULT_ENDPOINT,
        auth: ccAuth,
      };
    }

    const resolvedCC = data.confluent_cloud
      ? {
          ...data.confluent_cloud,
          endpoint:
            data.confluent_cloud.endpoint ?? CONFLUENT_CLOUD_DEFAULT_ENDPOINT,
        }
      : undefined;

    // Cast required: TypeScript cannot verify that spreading `data` (whose optional-field
    // types for confluent_cloud and telemetry) and overriding with fully resolved types
    // satisfies ConnectionConfig.
    return {
      ...data,
      confluent_cloud: resolvedCC,
      telemetry: resolvedTelemetry,
    } as ConnectionConfig;
  });

// Server block schemas. Defaults are applied at each level so that omitting the
// entire `server` block (or any sub-block) from YAML yields a fully-populated
// ServerConfig with all fields set. MCPServerConfiguration.server is therefore
// always non-optional and carries all operational settings.

const serverHttpConfigSchema = z
  .object({
    port: z.coerce.number().int().positive().default(8080),
    host: z.string().default("127.0.0.1"),
    mcp_endpoint: z.string().default("/mcp"),
    sse_endpoint: z.string().default("/sse"),
    sse_message_endpoint: z.string().default("/messages"),
  })
  .strict();

const serverAuthConfigSchema = z
  .object({
    api_key: z
      .string()
      .min(32, "server.auth.api_key must be at least 32 characters")
      .optional(),
    disabled: z.boolean().default(false),
    allowed_hosts: z
      .array(z.string())
      .default(() => ["localhost", "127.0.0.1"]),
  })
  .strict()
  .refine((auth) => !(auth.disabled === true && auth.api_key !== undefined), {
    message:
      "server.auth.disabled and server.auth.api_key cannot both be set — remove the api_key or set disabled: false",
  });

// Zod v4 requires .default() to receive a value (or factory) matching the schema's
// output type. Since each sub-schema's output type has required fields (those with
// their own .default() calls), we use factory functions so Zod resolves field-level
// defaults lazily through the schema itself rather than requiring a full literal here.
const serverConfigSchema = z
  .object({
    transports: z
      .array(
        z.enum(
          Object.values(TransportType) as [TransportType, ...TransportType[]],
        ),
      )
      .min(1, "server.transports must contain at least one transport")
      .refine((arr) => new Set(arr).size === arr.length, {
        message: "server.transports must not contain duplicate entries",
      })
      .default(() => [TransportType.STDIO]),
    log_level: z
      .enum(
        Object.keys(logLevels) as [
          keyof typeof logLevels,
          ...Array<keyof typeof logLevels>,
        ],
      )
      .default("info"),
    do_not_track: z.boolean().default(false),
    http: serverHttpConfigSchema.default(() =>
      serverHttpConfigSchema.parse({}),
    ),
    auth: serverAuthConfigSchema.default(() =>
      serverAuthConfigSchema.parse({}),
    ),
  })
  .strict();

// Compile-time assertion: ServerConfig interface must remain compatible with the schema output.
serverConfigSchema satisfies z.ZodType<ServerConfig>;

/**
 * The default server configuration produced when no `server` block is present in YAML
 * or when MCPServerConfiguration is constructed without an explicit server argument.
 * Derived from serverConfigSchema defaults — single source of truth.
 */
export const DEFAULT_SERVER_CONFIG = serverConfigSchema.parse({});

/** Zod schema for {@link CCloudOAuthConfig}. */
export const ccloudOAuthConfigSchema = z
  .object({
    type: z.literal("ccloud_oauth"),
    env: z.enum(["devel", "stag", "prod"]),
  })
  .strict();

/**
 * Root configuration schema. This is the single validation and normalisation
 * entry point shared by both configuration paths: YAML files (via
 * {@link parseYamlConfiguration}) and environment variables (via
 * {@link buildConfigFromEnvAndCli}). Transforms and cross-field rules defined here
 * therefore apply equally to both.
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
        enforceSingleConnectionOnly,
        "Exactly one connection must be defined (multiple connections not yet supported)",
      ),
    server: serverConfigSchema.default(() => DEFAULT_SERVER_CONFIG),
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

// Temporary guard: remove when multi-connection support (#151) lands.
function enforceSingleConnectionOnly(
  connections: Record<string, unknown>,
): boolean {
  return Object.keys(connections).length === 1;
}
