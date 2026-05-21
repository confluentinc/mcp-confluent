import { KafkaJS } from "@confluentinc/kafka-javascript";
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
  STATE_NAME_TO_ENUM,
  STATE_NAMES,
  stateName,
  TYPE_NAME_TO_ENUM,
  TYPE_NAMES,
  typeName,
} from "@src/confluent/tools/handlers/kafka/consumer-group-enums.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { z } from "zod";

export const listConsumerGroupsArgs = z.object({
  matchStates: z
    .array(z.enum(STATE_NAMES))
    .nonempty()
    .optional()
    .describe(
      "Filter to groups in any of these states. Omit to return all. " +
        'Options: "Stable" (live), "Empty" (orphaned), "Dead", ' +
        '"PreparingRebalance", "CompletingRebalance", "Unknown".',
    ),
  matchType: z
    .enum(TYPE_NAMES)
    .optional()
    .describe(
      "Filter to groups of this protocol type. Omit to return both. " +
        'Options: "Consumer" (new, KIP-848), "Classic" (legacy generation-based).',
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

/**
 * Wire-format response payload. `Record<string, unknown>` compatibility lets it
 * thread cleanly through MCP's `structuredContent` channel without a boundary
 * cast at the call site.
 */
export type ListConsumerGroupsResponse = {
  groups: Array<{
    groupId: string;
    state: string;
    type: string;
    protocolType: string;
    isSimpleConsumerGroup: boolean;
  }>;
  errors: Array<{ message: string; code?: number }>;
} & Record<string, unknown>;

export class ListConsumerGroupsHandler extends BaseToolHandler {
  readonly category = ToolCategory.Kafka;
  readonly predicate = kafkaBootstrapOrOAuth;

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.LIST_CONSUMER_GROUPS,
      description:
        "List consumer groups on a Kafka cluster — wraps the broker's " +
        "listGroups admin call. Optional filters narrow the result " +
        "server-side. Response carries one entry per group with groupId, " +
        "state, type, protocolType, and isSimpleConsumerGroup, plus an " +
        "errors array of any per-broker partial failures.",
      inputSchema: listConsumerGroupsArgs.shape,
      annotations: READ_ONLY,
    };
  }

  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const parsed = listConsumerGroupsArgs.parse(toolArguments);
    const { connId, clientManager } = this.resolveSoleConnection(runtime);
    const { clusterId, envId } = resolveKafkaClusterArgs(
      parsed,
      runtime,
      connId,
    );
    const admin = await clientManager.getKafkaAdminClient(clusterId, envId);

    try {
      const options: {
        matchConsumerGroupStates?: KafkaJS.ConsumerGroupStates[];
        matchConsumerGroupTypes?: KafkaJS.ConsumerGroupTypes[];
      } = {};
      if (parsed.matchStates !== undefined) {
        options.matchConsumerGroupStates = parsed.matchStates.map(
          (name) => STATE_NAME_TO_ENUM[name],
        );
      }
      if (parsed.matchType !== undefined) {
        options.matchConsumerGroupTypes = [TYPE_NAME_TO_ENUM[parsed.matchType]];
      }

      const { groups: rawGroups, errors: rawErrors } =
        await admin.listGroups(options);

      const filtered =
        parsed.matchStates !== undefined || parsed.matchType !== undefined;

      if (rawGroups.length === 0 && rawErrors.length > 0) {
        return this.createResponse(rawErrors[0]!.message, true);
      }

      const payload: ListConsumerGroupsResponse = {
        groups: rawGroups.map((g) => ({
          groupId: g.groupId,
          state: stateName(g.state),
          type: typeName(g.type),
          protocolType: g.protocolType,
          isSimpleConsumerGroup: g.isSimpleConsumerGroup,
        })),
        errors: rawErrors.map((e) => ({ message: e.message, code: e.code })),
      };

      const summary = filtered
        ? `Found ${payload.groups.length} consumer group(s) (filtered).`
        : `Found ${payload.groups.length} consumer group(s).`;

      return this.createStructuredResponse(summary, payload);
    } finally {
      await disposeIfOAuth(runtime, connId, admin);
    }
  }
}
