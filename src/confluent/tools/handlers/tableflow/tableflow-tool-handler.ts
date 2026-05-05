import type { DirectConnectionConfig } from "@src/config/index.js";
import { BaseToolHandler } from "@src/confluent/tools/base-tools.js";
import {
  connectionIdsWhere,
  hasTableflow,
} from "@src/confluent/tools/connection-predicates.js";
import { ServerRuntime } from "@src/server-runtime.js";

/**
 * Base for all Tableflow handlers. Requires only a tableflow auth block.
 *
 * Handlers that resolve `environmentId`/`clusterId` via
 * `resolveTableflowEnvAndClusterId()` are enabled here too: the kafka block is
 * optional at enablement time because callers can supply those IDs as explicit
 * tool arguments. When a kafka block is present its `env_id`/`cluster_id` fields
 * serve as config fallbacks; the handler throws only when a required ID is absent
 * from both the call arguments and the connection config.
 */
export abstract class TableflowToolHandler extends BaseToolHandler {
  enabledConnectionIds(runtime: ServerRuntime): string[] {
    return connectionIdsWhere(runtime.config.connections, hasTableflow);
  }

  /**
   * Resolves the environment ID and Kafka cluster ID for a Tableflow operation,
   * preferring explicit tool arguments over connection config fallbacks.
   */
  protected resolveTableflowEnvAndClusterId(
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
