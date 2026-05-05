import type { DirectConnectionConfig } from "@src/config/index.js";
import { BaseToolHandler } from "@src/confluent/tools/base-tools.js";
import {
  connectionIdsWhere,
  hasTableflowWithKafka,
} from "@src/confluent/tools/connection-predicates.js";
import { ServerRuntime } from "@src/server-runtime.js";

export abstract class TableflowToolHandler extends BaseToolHandler {
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
