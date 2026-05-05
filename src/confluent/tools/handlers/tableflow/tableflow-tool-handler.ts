import type { DirectConnectionConfig } from "@src/config/index.js";
import { BaseToolHandler } from "@src/confluent/tools/base-tools.js";
import {
  connectionIdsWhere,
  hasTableflow,
  hasTableflowWithKafka,
} from "@src/confluent/tools/connection-predicates.js";
import { ServerRuntime } from "@src/server-runtime.js";

/**
 * Base for Tableflow handlers that require only a tableflow auth block.
 * Covers tools that either need no env/cluster IDs at all (e.g. list-regions)
 * or receive them entirely from the caller's request body (e.g. update-topic).
 */
export abstract class TableflowOnlyToolHandler extends BaseToolHandler {
  enabledConnectionIds(runtime: ServerRuntime): string[] {
    return connectionIdsWhere(runtime.config.connections, hasTableflow);
  }
}

/**
 * Base for Tableflow handlers that also require a kafka block.
 * The kafka block supplies `env_id` and `cluster_id` as config fallbacks for
 * `resolveTableflowEnvAndClusterId()`; without it those handlers would throw on
 * every invocation regardless of caller-supplied args.
 */
export abstract class TableflowWithKafkaToolHandler extends BaseToolHandler {
  enabledConnectionIds(runtime: ServerRuntime): string[] {
    return connectionIdsWhere(
      runtime.config.connections,
      hasTableflowWithKafka,
    );
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
