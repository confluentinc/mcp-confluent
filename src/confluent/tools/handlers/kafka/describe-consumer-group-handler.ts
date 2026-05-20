import { KafkaJS } from "@confluentinc/kafka-javascript";
import type {
  GroupDescription,
  MemberDescription,
} from "@confluentinc/kafka-javascript/types/rdkafka.js";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  READ_ONLY,
  ToolCategory,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import {
  disposeIfOAuth,
  resolveKafkaClusterArgs,
} from "@src/confluent/tools/cluster-arg-resolvers.js";
import { kafkaBootstrapOrOAuth } from "@src/confluent/tools/connection-predicates.js";
import {
  stateName,
  typeName,
} from "@src/confluent/tools/handlers/kafka/consumer-group-enums.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { z } from "zod";

export const describeConsumerGroupArgs = z.object({
  groupId: z
    .string()
    .min(1)
    .describe(
      "Consumer group ID to describe. Discover existing group IDs via list-consumer-groups.",
    ),
  cluster_id: z
    .string()
    .optional()
    .describe(
      "Confluent Cloud logical Kafka cluster ID (lkc-...). Discover via list-clusters.",
    ),
  environment_id: z
    .string()
    .optional()
    .describe(
      "Confluent Cloud environment ID (env-...) that owns the cluster. Discover via list-environments.",
    ),
});

/** One topic/partition pair from a member's assignment. Deliberately narrower
 *  than the upstream {@link KafkaJS} `TopicPartition` — that type carries
 *  optional `error` and `leaderEpoch` fields which aren't meaningful for a
 *  consumer-group member assignment payload, so the handler strips them so
 *  callers see exactly the two-field shape the issue spec promised. */
export type AssignedPartition = { topic: string; partition: number };

/** Per-member entry on the response. `groupInstanceId` is present only when
 *  the upstream {@link MemberDescription} carries it (static membership). */
export type DescribeConsumerGroupMember = {
  memberId: string;
  clientId: string;
  clientHost: string;
  groupInstanceId?: string;
  assignment: AssignedPartition[];
};

/** Coordinator entry on the response. `rack` is present only when the
 *  upstream {@link KafkaJS} `Node` carries it. */
export type DescribeConsumerGroupCoordinator = {
  id: number;
  host: string;
  port: number;
  rack?: string;
};

/**
 * Wire-format response payload. `Record<string, unknown>` compatibility lets
 * it thread cleanly through MCP's `structuredContent` channel without a
 * boundary cast at the call site.
 *
 * Deliberately omits the raw `memberAssignment` / `memberMetadata` Buffer
 * fields the upstream {@link MemberDescription} carries — they're
 * librdkafka's protocol-level encoded form and useless to an LLM caller.
 * The cooked {@link TopicPartition}[] on `assignment` is the equivalent
 * information in a callable shape.
 */
export type DescribeConsumerGroupResponse = {
  groupId: string;
  state: string;
  type: string;
  protocol: string;
  partitionAssignor: string;
  isSimpleConsumerGroup: boolean;
  coordinator: DescribeConsumerGroupCoordinator;
  members: DescribeConsumerGroupMember[];
} & Record<string, unknown>;

export class DescribeConsumerGroupHandler extends BaseToolHandler {
  readonly category = ToolCategory.Kafka;
  readonly predicate = kafkaBootstrapOrOAuth;

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.DESCRIBE_CONSUMER_GROUP,
      description:
        "Describe a single consumer group on a Kafka cluster — wraps the " +
        "broker's describeGroups admin call for one group ID. Returns the " +
        "group's state, type, protocol, partition assignor, coordinator, " +
        "and per-member assignment (cooked TopicPartition[] form, not the " +
        "raw librdkafka memberAssignment Buffer).",
      inputSchema: describeConsumerGroupArgs.shape,
      annotations: READ_ONLY,
    };
  }

  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const parsed = describeConsumerGroupArgs.parse(toolArguments);
    const { connId, clientManager } = this.resolveSoleConnection(runtime);
    const { clusterId, envId } = resolveKafkaClusterArgs(
      parsed,
      runtime,
      connId,
    );
    const admin = await clientManager.getKafkaAdminClient(clusterId, envId);

    try {
      let raw: { groups: GroupDescription[] };
      try {
        raw = await admin.describeGroups([parsed.groupId]);
      } catch (err) {
        if (isGroupIdNotFoundError(err)) {
          return this.createResponse(notFoundMessage(parsed.groupId), true);
        }
        throw err;
      }

      const groupDesc = raw.groups[0];
      // Wacky -- `describeGroups([oneId])` reliably returns one entry per
      // requested id (the per-group error embedded in `GroupDescription.error`
      // is the path for not-found). An empty groups array here means the
      // broker returned nothing addressable to the requested id, so treat it
      // as not-found rather than crash on `groupDesc.groupId` below.
      if (groupDesc === undefined) {
        return this.createResponse(notFoundMessage(parsed.groupId), true);
      }

      if (groupDesc.error !== undefined) {
        if (
          groupDesc.error.code === KafkaJS.ErrorCodes.ERR_GROUP_ID_NOT_FOUND
        ) {
          return this.createResponse(notFoundMessage(parsed.groupId), true);
        }
        return this.createResponse(groupDesc.error.message, true);
      }

      if (isUnknownGroupTombstone(groupDesc)) {
        return this.createResponse(notFoundMessage(parsed.groupId), true);
      }

      const payload: DescribeConsumerGroupResponse = {
        groupId: groupDesc.groupId,
        state: stateName(groupDesc.state),
        type: typeName(groupDesc.type),
        protocol: groupDesc.protocol,
        partitionAssignor: groupDesc.partitionAssignor,
        isSimpleConsumerGroup: groupDesc.isSimpleConsumerGroup,
        coordinator: buildCoordinator(groupDesc.coordinator),
        members: groupDesc.members.map(buildMember),
      };

      const summary =
        `Consumer group "${payload.groupId}" is ${payload.state} ` +
        `with ${payload.members.length} member(s); ` +
        `coordinator ${payload.coordinator.host}:${payload.coordinator.port}.`;

      return this.createStructuredResponse(summary, payload);
    } finally {
      await disposeIfOAuth(runtime, connId, admin);
    }
  }
}

function notFoundMessage(groupId: string): string {
  return `Consumer group "${groupId}" not found on this cluster.`;
}

/**
 * Narrow an unknown rejection to a librdkafka `ERR_GROUP_ID_NOT_FOUND` error.
 * The kafkajs-flavored `describeGroups` surfaces unknown groups either as a
 * top-level rejection (this path) or as a per-group `GroupDescription.error`
 * (handled separately); the handler normalizes both into the same caller-
 * friendly tool-level error.
 */
function isGroupIdNotFoundError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code ===
      KafkaJS.ErrorCodes.ERR_GROUP_ID_NOT_FOUND
  );
}

/**
 * Third path the broker uses to report an unknown group: a successful-shaped
 * {@link GroupDescription} with no `.error` field, state `Dead`, no members,
 * and empty `protocol` / `partitionAssignor` strings. Confluent Cloud's
 * brokers were observed taking this path (integration-test discovery, May
 * 2026) rather than the documented `ERR_GROUP_ID_NOT_FOUND` paths.
 *
 * The empty `protocol` and `partitionAssignor` are the load-bearing signal:
 * a group that previously lived and has since died would still carry its
 * last-used protocol name. Both fields being empty means the broker never
 * had a record of this group to begin with. Long-tombstoned real groups
 * could in principle match the same fingerprint once the broker drops the
 * retained protocol metadata; accepted as an exotic-edge false-positive in
 * exchange for the friendly UX the spec asked for.
 */
function isUnknownGroupTombstone(groupDesc: GroupDescription): boolean {
  return (
    groupDesc.state === KafkaJS.ConsumerGroupStates.DEAD &&
    groupDesc.members.length === 0 &&
    groupDesc.protocol === "" &&
    groupDesc.partitionAssignor === ""
  );
}

function buildCoordinator(
  node: GroupDescription["coordinator"],
): DescribeConsumerGroupCoordinator {
  const out: DescribeConsumerGroupCoordinator = {
    id: node.id,
    host: node.host,
    port: node.port,
  };
  if (node.rack !== undefined) out.rack = node.rack;
  return out;
}

function buildMember(member: MemberDescription): DescribeConsumerGroupMember {
  const out: DescribeConsumerGroupMember = {
    memberId: member.memberId,
    clientId: member.clientId,
    clientHost: member.clientHost,
    // Map field-by-field rather than passing the upstream TopicPartition
    // array verbatim — the upstream type carries optional `error` /
    // `leaderEpoch` fields we don't want leaking into the response.
    assignment: member.assignment.map(({ topic, partition }) => ({
      topic,
      partition,
    })),
  };
  if (member.groupInstanceId !== undefined) {
    out.groupInstanceId = member.groupInstanceId;
  }
  return out;
}
