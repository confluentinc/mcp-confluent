/**
 * Cluster-arg resolver for #313 native Kafka handlers. Asymmetric by connection
 * type:
 *
 * - Direct: returns `{ clusterId: undefined, envId: undefined }`. The
 *   `DirectClientManager` ignores cluster args and uses its eagerly-built
 *   single-instance client(s); the handler passes the undefineds through.
 * - OAuth: requires the args; throws with a discovery hint if missing.
 *
 * Spec: docs/superpowers/specs/2026-05-05-oauth-client-lifecycle-design.md
 *
 * The Schema Registry counterpart was removed when SR-under-OAuth was scoped
 * out of the initial #313/#312 ship. It will return alongside the
 * list-schema-registry-clusters tool that closes the discovery gap.
 */

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
      "cluster_id and environment_id are required under --oauth. Call list-clusters " +
        "with environment_id and pass the cluster's `id` and `spec.environment.id`.",
    );
  }
  return { clusterId: args.cluster_id, envId: args.environment_id };
}
