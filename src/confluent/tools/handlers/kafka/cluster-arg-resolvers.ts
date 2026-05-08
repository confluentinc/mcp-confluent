/**
 * Cluster-arg resolver for native Kafka handlers. Asymmetric by connection
 * type:
 *
 * - Direct: returns `{ clusterId: undefined, envId: undefined }`. The
 *   `DirectClientManager` ignores cluster args and uses its eagerly-built
 *   single-instance client(s); the handler passes the undefineds through.
 * - OAuth: requires the args; throws with a discovery hint if missing.
 *   Handlers catch the throw at entry and convert to a `CallToolResult`
 *   with `isError: true` so the agent receives a normal tool-call error
 *   rather than an RPC failure.
 */

import { KafkaJS } from "@confluentinc/kafka-javascript";
import { logger } from "@src/logger.js";
import { ServerRuntime } from "@src/server-runtime.js";

export function resolveKafkaClusterArgs(
  args: { cluster_id?: string; environment_id?: string },
  runtime: ServerRuntime,
  connId: string,
): { clusterId: string | undefined; envId: string | undefined } {
  const conn = runtime.config.connections[connId]!;

  if (conn.type === "direct") {
    return { clusterId: undefined, envId: undefined };
  }

  if (args.cluster_id === undefined || args.environment_id === undefined) {
    throw new Error(
      "cluster_id and environment_id are required under OAuth connection type. " +
        "Discover the environment via list-environments, then call list-clusters " +
        "with environment_id and pass the cluster's `id` and `spec.environment.id`.",
    );
  }
  return { clusterId: args.cluster_id, envId: args.environment_id };
}

/**
 * REST-tool variant of {@link resolveKafkaClusterArgs}. The Kafka REST API
 * places `cluster_id` directly in the URL path
 * (e.g. `/kafka/v3/clusters/{id}/topics`), so the handler always needs a
 * concrete cluster id — even on direct connections that omit the arg and
 * rely on the configured fallback.
 *
 * Direct: `args.clusterId ?? conn.kafka?.cluster_id`; throws if neither.
 *   `envId` is unused (direct's `kafka.rest_endpoint` already targets the
 *   per-cluster hostname).
 * OAuth: both `clusterId` and `environmentId` required. Argument names are
 *   camelCase to match the existing input-schema convention of these tools
 *   and `list-clusters`; the native-Kafka tools' snake_case `cluster_id` is
 *   a separate convention.
 */
export function resolveKafkaRestArgs(
  args: { clusterId?: string; environmentId?: string },
  runtime: ServerRuntime,
  connId: string,
): { clusterId: string; envId: string | undefined } {
  const conn = runtime.config.connections[connId]!;

  if (conn.type === "direct") {
    const clusterId = args.clusterId ?? conn.kafka?.cluster_id;
    if (!clusterId) {
      throw new Error(
        "clusterId is required: pass it as a tool argument or set kafka.cluster_id in the connection config.",
      );
    }
    return { clusterId, envId: undefined };
  }

  if (!args.clusterId || !args.environmentId) {
    throw new Error(
      "clusterId and environmentId are required under OAuth connection type. " +
        "Discover the environment via list-environments, then call list-clusters " +
        "with environmentId and pass the cluster's `id` and `spec.environment.id`.",
    );
  }
  return { clusterId: args.clusterId, envId: args.environmentId };
}

/**
 * Disposes a Kafka client (admin or producer) iff the connection is OAuth-typed.
 * On direct connections this is a no-op — direct's `AsyncLazy` admin/producer
 * are manager-owned singletons and must not be disconnected by handlers. On
 * OAuth, calls `client.disconnect()` and swallows + logs any error so disposal
 * failure never masks the handler's own error.
 */
export async function disposeIfOAuth(
  runtime: ServerRuntime,
  connId: string,
  client: { disconnect: () => Promise<void> },
): Promise<void> {
  if (runtime.config.connections[connId]!.type !== "oauth") return;
  try {
    await client.disconnect();
  } catch (err) {
    logger.warn({ err, connId }, "OAuth Kafka client disconnect failed");
  }
}

/**
 * Renders any error thrown from a Kafka admin/producer/consumer call into a
 * single agent-readable string. Preserves per-topic-cause unwrapping for
 * `KafkaJSAggregateError`, surfaces `KafkaJSError.code` when present, and
 * falls back gracefully for unknown shapes.
 */
export function formatKafkaError(err: unknown): string {
  if (err instanceof KafkaJS.KafkaJSAggregateError) {
    const details = err.errors
      .map((inner) => {
        if (inner instanceof KafkaJS.KafkaJSCreateTopicError) {
          return `- ${inner.topic}: ${inner.message}`;
        }
        if (inner instanceof KafkaJS.KafkaJSError) {
          return `- ${inner.code ?? "unknown"}: ${inner.message}`;
        }
        return `- ${typeof inner === "string" ? inner : String(inner)}`;
      })
      .join("\n");
    return `${err.message}\n${details}`;
  }
  if (err instanceof KafkaJS.KafkaJSError) {
    return `Kafka error (${err.code ?? "unknown"}): ${err.message}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
