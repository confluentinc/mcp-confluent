import { KafkaJS } from "@confluentinc/kafka-javascript";
import type {
  GroupDescription,
  LibrdKafkaError,
} from "@confluentinc/kafka-javascript/types/rdkafka.js";

/**
 * Single source of truth for the user-facing "group not found" message —
 * surfaced by both `describe-consumer-group` and `get-consumer-group-lag`
 * across every broker shape that signals an unknown group ID.
 */
export function notFoundGroupMessage(groupId: string): string {
  return `Consumer group "${groupId}" not found on this cluster.`;
}

/**
 * Narrow an unknown rejection (from `admin.describeGroups` or
 * `admin.fetchOffsets`) to a librdkafka `ERR_GROUP_ID_NOT_FOUND` error —
 * the most direct of the three not-found shapes the broker can take.
 */
export function isGroupIdNotFoundError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code ===
      KafkaJS.ErrorCodes.ERR_GROUP_ID_NOT_FOUND
  );
}

/**
 * Third path the broker uses to report an unknown group: a
 * successful-shaped {@link GroupDescription} with no `.error` field, state
 * `Dead`, no members, and empty `protocol` / `partitionAssignor` strings.
 * Confluent Cloud's brokers were observed taking this path
 * rather than the documented
 * `ERR_GROUP_ID_NOT_FOUND` paths.
 *
 * The empty `protocol` and `partitionAssignor` are the load-bearing
 * signal: a group that previously lived and has since died would still
 * carry its last-used protocol name. Both fields being empty means the
 * broker never had a record of this group to begin with. Long-tombstoned
 * real groups could in principle match the same fingerprint once the
 * broker drops the retained protocol metadata; accepted as an exotic-edge
 * false-positive in exchange for the friendly UX the spec asks for.
 */
function isUnknownGroupTombstone(groupDesc: GroupDescription): boolean {
  return (
    groupDesc.state === KafkaJS.ConsumerGroupStates.DEAD &&
    groupDesc.members.length === 0 &&
    groupDesc.protocol === "" &&
    groupDesc.partitionAssignor === ""
  );
}

/**
 * Tagged-union outcome of {@link describeGroupOutcome}. Collapses the
 * four shapes the broker can use to report a single-group describe into
 * three arms a caller can switch on:
 *
 * - `notFound`: the group is absent from the cluster, regardless of
 *   which of the four broker shapes surfaced that fact (top-level
 *   `ERR_GROUP_ID_NOT_FOUND` rejection; empty `groups` array; per-group
 *   `.error` with that code; the dead-tombstone fingerprint Confluent
 *   Cloud actually takes for unknown groups).
 * - `error`: per-group `.error` carrying some non-not-found librdkafka
 *   code. Callers decide whether to surface as a friendly tool-level
 *   error (`describe-consumer-group`) or propagate via throw
 *   (`get-consumer-group-lag`'s existence probe).
 * - `ok`: a real {@link GroupDescription} the caller can inspect.
 */
export type DescribeGroupOutcome =
  | { kind: "notFound" }
  | { kind: "error"; error: LibrdKafkaError }
  | { kind: "ok"; group: GroupDescription };

/**
 * Single-group describe with every not-found surface collapsed into one
 * tagged union. Shared between `describe-consumer-group` (which surfaces
 * the not-found and error arms as friendly tool-level responses) and
 * `get-consumer-group-lag`'s existence probe (which maps not-found to
 * its friendly message and lets the error arm propagate via throw); the
 * decoding logic stays in one place so the broker's four not-found
 * shapes can't drift apart between the two callers.
 *
 * Non-not-found top-level rejections (auth failures, broker
 * unavailability, etc.) propagate via throw — they're neither a
 * not-found signal nor a per-group error.
 */
export async function describeGroupOutcome(
  admin: KafkaJS.Admin,
  groupId: string,
): Promise<DescribeGroupOutcome> {
  let result: { groups: GroupDescription[] };
  try {
    result = await admin.describeGroups([groupId]);
  } catch (err) {
    if (isGroupIdNotFoundError(err)) return { kind: "notFound" };
    throw err;
  }
  // Wacky -- `describeGroups([oneId])` reliably returns one entry per
  // requested id; the per-group `.error` field is the path for
  // not-found, not an empty `groups` array. Treat an empty array as
  // not-found defensively rather than crash on `desc.groupId` below.
  const desc = result.groups[0];
  if (desc === undefined) return { kind: "notFound" };
  // `!= null` (loose equality) covers both `undefined` (the
  // TypeScript-declared shape) and `null` (what kafkajs-compat actually
  // populates when no error occurred — the upstream type lies about
  // the runtime).
  if (desc.error != null) {
    if (desc.error.code === KafkaJS.ErrorCodes.ERR_GROUP_ID_NOT_FOUND) {
      return { kind: "notFound" };
    }
    return { kind: "error", error: desc.error };
  }
  if (isUnknownGroupTombstone(desc)) {
    return { kind: "notFound" };
  }
  return { kind: "ok", group: desc };
}
