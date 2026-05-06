import { DirectConnectionConfig } from "@src/config/models.js";
import { BaseToolHandler } from "@src/confluent/tools/base-tools.js";
import {
  connectionIdsWhere,
  hasDirectConfluentCloud,
} from "@src/confluent/tools/connection-predicates.js";
import { ServerRuntime } from "@src/server-runtime.js";

/**
 * Intermediate base class for all Connect tool handlers.
 * Gates enablement on `hasDirectConfluentCloud` and exposes
 * `resolveConnectEnvAndClusterId` for consistent env/cluster resolution.
 */
export abstract class ConnectToolHandler extends BaseToolHandler {
  enabledConnectionIds(runtime: ServerRuntime): string[] {
    return connectionIdsWhere(
      runtime.config.connections,
      hasDirectConfluentCloud,
    );
  }

  /**
   * Resolves environment and Kafka cluster IDs from explicit tool args,
   * falling back to the connection's `kafka.env_id` / `kafka.cluster_id`.
   * Throws if either value is absent from both sources.
   */
  protected resolveConnectEnvAndClusterId(
    conn: DirectConnectionConfig,
    envIdArg: string | undefined,
    clusterIdArg: string | undefined,
  ): { environment_id: string; kafka_cluster_id: string } {
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
