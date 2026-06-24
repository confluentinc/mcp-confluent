import { ConnectionConfig } from "@src/config/models.js";
import {
  BaseToolHandler,
  ToolCategory,
} from "@src/confluent/tools/base-tools.js";
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
   *
   * - Direct: explicit tool args win, falling back to the connection's
   *   `kafka.env_id` / `kafka.cluster_id`. Throws if either value is absent from
   *   both sources.
   * - OAuth: both args are required (an OAuth connection carries no `kafka`
   *   block to fall back to). Throws a discovery hint pointing at
   *   `list-environments` / `list-clusters` when either is missing.
   */
  protected resolveConnectEnvAndClusterId(
    conn: ConnectionConfig,
    envIdArg: string | undefined,
    clusterIdArg: string | undefined,
  ): { environment_id: string; kafka_cluster_id: string } {
    if (conn.type === "oauth") {
      const environment_id = envIdArg?.trim();
      const kafka_cluster_id = clusterIdArg?.trim();
      if (!environment_id || !kafka_cluster_id) {
        throw new Error(
          "environmentId and clusterId are required under OAuth connection type. " +
            "Discover via list-environments, then call list-clusters " +
            "with environmentId for the clusterId.",
        );
      }
      return { environment_id, kafka_cluster_id };
    }
    return {
      environment_id: this.resolveParam(
        envIdArg,
        conn.kafka?.env_id,
        "Environment ID",
      ),
      kafka_cluster_id: this.resolveParam(
        clusterIdArg,
        conn.kafka?.cluster_id,
        "Kafka Cluster ID",
      ),
    };
  }
}
