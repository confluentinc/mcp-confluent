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
import {
  describeGroupOutcome,
  notFoundGroupMessage,
} from "@src/confluent/tools/handlers/kafka/consumer-group-helpers.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { logger } from "@src/logger.js";
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
 * Each member's {@link AssignedPartition}[] on `assignment` is the
 * equivalent information in a callable shape, narrower than the upstream
 * {@link KafkaJS} `TopicPartition` (no `error` / `leaderEpoch` fields).
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
        "Describe a single consumer group on a Kafka cluster. " +
        "Returns the group's state, type, protocol, partition assignor, " +
        "coordinator, and per-member assignment as a flat array " +
        "of {topic, partition} pairs.",
      inputSchema: describeConsumerGroupArgs.shape,
      annotations: READ_ONLY,
    };
  }

  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const parsed = describeConsumerGroupArgs.parse(toolArguments);
    const { connId, clientManager } = this.resolveConnection(
      runtime,
      toolArguments,
    );
    const { clusterId, envId } = resolveKafkaClusterArgs(
      parsed,
      runtime,
      connId,
    );
    const admin = await clientManager.getKafkaAdminClient(clusterId, envId);

    try {
      const outcome = await describeGroupOutcome(admin, parsed.groupId);
      if (outcome.kind === "notFound") {
        return this.createResponse(notFoundGroupMessage(parsed.groupId), true);
      }
      if (outcome.kind === "error") {
        return this.createResponse(outcome.error.message, true);
      }
      const groupDesc = outcome.group;

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
    assignment: buildAssignment(member),
  };
  if (member.groupInstanceId !== undefined) {
    out.groupInstanceId = member.groupInstanceId;
  }
  return out;
}

/**
 * Cooked partition-list extraction from a {@link MemberDescription}'s
 * `assignment` field, working around an upstream type/runtime mismatch.
 *
 * The kafkajs `.d.ts` declares `assignment: TopicPartition[]` (flat array),
 * but the native C++ binding actually returns `assignment: { topicPartitions:
 * TopicPartition[] }` (wrapped object) — verified in
 * `node_modules/@confluentinc/kafka-javascript/src/common.cc` →
 * `FromMemberDescription`. The wrapped shape is also where the binding
 * exposes an optional `targetAssignment: { topicPartitions: ... }` field
 * the `.d.ts` doesn't acknowledge at all.
 *
 * Handle both shapes defensively: if the binding ever reconciles the
 * mismatch in either direction, the handler keeps working. Anything else
 * gets a "Wacky --" log and falls through to an empty array so a future
 * binding surprise doesn't crash the tool.
 *
 * Map field-by-field rather than passing the upstream array verbatim —
 * the upstream `TopicPartition` carries optional `error` / `leaderEpoch`
 * fields we don't want leaking into the response.
 */
function buildAssignment(
  member: MemberDescription,
): DescribeConsumerGroupMember["assignment"] {
  const raw = member.assignment as unknown;

  if (Array.isArray(raw)) {
    return raw.map(toAssignedPartition);
  }

  if (
    raw !== null &&
    typeof raw === "object" &&
    "topicPartitions" in raw &&
    Array.isArray((raw as { topicPartitions: unknown }).topicPartitions)
  ) {
    return (
      raw as { topicPartitions: Array<{ topic: string; partition: number }> }
    ).topicPartitions.map(toAssignedPartition);
  }

  logger.warn(
    {
      memberId: member.memberId,
      clientId: member.clientId,
      assignmentType: typeof raw,
      isBuffer: Buffer.isBuffer(raw),
      sampleKeys:
        raw !== null && typeof raw === "object" && !Buffer.isBuffer(raw)
          ? Object.keys(raw).slice(0, 10)
          : undefined,
    },
    "Wacky -- MemberDescription.assignment is neither a TopicPartition[] " +
      "nor a {topicPartitions: TopicPartition[]} wrapper; surfacing as empty array.",
  );
  return [];
}

function toAssignedPartition(tp: {
  topic: string;
  partition: number;
}): AssignedPartition {
  return { topic: tp.topic, partition: tp.partition };
}
