import type { ConnectionConfig } from "@src/config/models.js";
import {
  BaseToolHandler,
  ToolCategory,
} from "@src/confluent/tools/base-tools.js";
import { resolveEnvAndClusterArgs } from "@src/confluent/tools/cluster-arg-resolvers.js";
import { hasTableflowOrOAuth } from "@src/confluent/tools/connection-predicates.js";

/**
 * Base for all Tableflow handlers. Requires a tableflow block on direct
 * connections; OAuth connections satisfy enablement unconditionally
 * ({@linkcode hasTableflowOrOAuth}) — the Tableflow REST surface rides the
 * cloud control-plane URL and token wired in `OAuthClientManager`.
 *
 * Handlers that resolve `environmentId`/`clusterId` via
 * `resolveTableflowEnvAndClusterId()` are enabled here too: the kafka block is
 * optional at enablement time because callers can supply those IDs as explicit
 * tool arguments. On direct connections a present kafka block's
 * `env_id`/`cluster_id` fields serve as config fallbacks; on OAuth connections
 * there is no block to fall back to, so both IDs are required as arguments.
 * Either way the handler throws when a required ID is absent.
 */
export abstract class TableflowToolHandler extends BaseToolHandler {
  readonly category = ToolCategory.Tableflow;
  readonly predicate = hasTableflowOrOAuth;

  /**
   * Resolves the environment ID and Kafka cluster ID for a Tableflow operation.
   * Delegates to the shared {@link resolveEnvAndClusterArgs} (direct: args win,
   * falling back to `kafka.env_id`/`kafka.cluster_id`; OAuth: both args
   * required with a discovery hint).
   */
  protected resolveTableflowEnvAndClusterId(
    conn: ConnectionConfig,
    envIdArg: string | undefined,
    clusterIdArg: string | undefined,
  ): { environment_id: string; kafka_cluster_id: string } {
    return resolveEnvAndClusterArgs(conn, envIdArg, clusterIdArg);
  }
}
