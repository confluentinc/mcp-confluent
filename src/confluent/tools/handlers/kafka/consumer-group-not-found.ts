import { KafkaJS } from "@confluentinc/kafka-javascript";
import type { GroupDescription } from "@confluentinc/kafka-javascript/types/rdkafka.js";

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
 * (integration-test discovery, May 2026) rather than the documented
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
export function isUnknownGroupTombstone(groupDesc: GroupDescription): boolean {
  return (
    groupDesc.state === KafkaJS.ConsumerGroupStates.DEAD &&
    groupDesc.members.length === 0 &&
    groupDesc.protocol === "" &&
    groupDesc.partitionAssignor === ""
  );
}
