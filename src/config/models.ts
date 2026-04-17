import { validateBootstrapServers } from "@src/config/validation.js";
import { z } from "zod";

/**
 * Connection configuration for a direct (local/Docker) Kafka cluster.
 * No authentication required. At least one of kafka or schema_registry must be present.
 */
export interface DirectConnectionConfig {
  type: "direct";
  kafka?: {
    bootstrap_servers: string;
  };
  schema_registry?: {
    endpoint: string;
  };
}

/**
 * Union of all connection types (future-proof discriminated union).
 * Currently only supports "direct" type.
 */
export type ConnectionConfig = DirectConnectionConfig;

/**
 * Root configuration object representing the entire MCP server configuration.
 */
export interface MCPServerConfiguration {
  connections: Record<string, ConnectionConfig>;
}

// Zod schema for direct connection type
const directConnectionSchema = z.object({
  type: z.literal("direct"),
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
    })
    .optional(),
  schema_registry: z
    .object({
      endpoint: z
        .string()
        .trim()
        .url("schema_registry.endpoint must be a valid URL"),
    })
    .optional(),
});

// Discriminated union of all connection types (currently just direct).
// superRefine is placed here (after the union) rather than on directConnectionSchema
// because wrapping a ZodObject in ZodEffects breaks z.discriminatedUnion's discriminant lookup.
const connectionConfigSchema = z
  .discriminatedUnion("type", [directConnectionSchema])
  .superRefine((data, ctx) => {
    if (data.type === "direct" && !data.kafka && !data.schema_registry) {
      ctx.addIssue({
        code: "custom",
        message: "At least one of 'kafka' or 'schema_registry' must be defined",
      });
    }
  });

// Root configuration schema
export const mcpConfigSchema = z.object({
  connections: z
    .record(
      z.string().trim().min(1, "Connection name cannot be empty"),
      connectionConfigSchema,
    )
    .refine(
      (connections) => Object.keys(connections).length === 1,
      "Exactly one connection must be defined (multiple connections not yet supported)",
    ),
});
