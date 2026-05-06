/**
 * Cluster-arg resolver for native Kafka handlers. Asymmetric by connection
 * type:
 *
 * - Direct: returns `{ clusterId: undefined, envId: undefined }`. The
 *   `DirectClientManager` ignores cluster args and uses its eagerly-built
 *   single-instance client(s); the handler passes the undefineds through.
 * - OAuth: requires the args; throws with a discovery hint if missing.
 *
 * The Schema Registry counterpart was removed when SR-under-OAuth was scoped
 * out of the initial #313/#312 ship. It will return alongside the
 * list-schema-registry-clusters tool that closes the discovery gap.
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
      "cluster_id and environment_id are required under OAuth connection type. Call list-clusters " +
        "with environment_id and pass the cluster's `id` and `spec.environment.id`.",
    );
  }
  return { clusterId: args.cluster_id, envId: args.environment_id };
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
    return `Kafka error (${err.code}): ${err.message}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
