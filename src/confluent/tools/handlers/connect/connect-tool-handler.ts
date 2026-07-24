import type { ConnectionConfig } from "@src/config/models.js";
import {
  BaseToolHandler,
  ToolCategory,
} from "@src/confluent/tools/base-tools.js";
import { resolveEnvAndClusterArgs } from "@src/confluent/tools/cluster-arg-resolvers.js";
import { hasConfluentCloudOrOAuth } from "@src/confluent/tools/connection-predicates.js";
import { z } from "zod";

/**
 * Shared Zod input schema for tools that operate on a single connector by name.
 * `environmentId` and `clusterId` are optional and fall back to the
 * connection's `kafka.env_id` / `kafka.cluster_id` via
 * `resolveConnectEnvAndClusterId`. `connectorName` is required.
 */
export const connectorByNameArguments = z.object({
  environmentId: z
    .string()
    .trim()
    .optional()
    .describe(
      "The unique identifier for the environment this resource belongs to.",
    ),
  clusterId: z
    .string()
    .trim()
    .optional()
    .describe("The unique identifier for the Kafka cluster."),
  connectorName: z
    .string()
    .trim()
    .nonempty()
    .describe("The unique name of the connector."),
});

/**
 * Intermediate base class for all Connect tool handlers.
 * Gates enablement on `hasConfluentCloudOrOAuth` and exposes
 * `resolveConnectEnvAndClusterId` for consistent env/cluster resolution.
 */
export abstract class ConnectToolHandler extends BaseToolHandler {
  readonly category = ToolCategory.Connect;
  readonly predicate = hasConfluentCloudOrOAuth;

  /**
   * Resolves environment and Kafka cluster IDs for a Connect REST call.
   * Delegates to the shared {@link resolveEnvAndClusterArgs} (direct: args win,
   * falling back to `kafka.env_id`/`kafka.cluster_id`; OAuth: both args
   * required with a discovery hint).
   */
  protected resolveConnectEnvAndClusterId(
    conn: ConnectionConfig,
    envIdArg: string | undefined,
    clusterIdArg: string | undefined,
  ): { environment_id: string; kafka_cluster_id: string } {
    return resolveEnvAndClusterArgs(conn, envIdArg, clusterIdArg);
  }
}
