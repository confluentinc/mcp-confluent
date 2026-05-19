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
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { logger } from "@src/logger.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { z } from "zod";

/**
 * Hand-listed to stay in lockstep with the {@link KafkaJS.ConsumerGroupStates}
 * numeric enum in `@confluentinc/kafka-javascript/types/rdkafka.d.ts`. Not
 * derived via `Object.values(KafkaJS.ConsumerGroupStates)` because TypeScript
 * reverse-maps numeric enums and would surface both names and numbers, which
 * Zod's `z.enum` rejects.
 */
const STATE_NAMES = [
  "Unknown",
  "PreparingRebalance",
  "CompletingRebalance",
  "Stable",
  "Dead",
  "Empty",
] as const;

/**
 * Hand-listed to stay in lockstep with the {@link KafkaJS.ConsumerGroupTypes}
 * numeric enum (see {@link STATE_NAMES} for why we don't derive).
 */
const TYPE_NAMES = ["Classic", "Consumer"] as const;

type StateName = (typeof STATE_NAMES)[number];
type TypeName = (typeof TYPE_NAMES)[number];

/**
 * Zod-input name → numeric enum value forwarded to `admin.listGroups`.
 * Exported for the colocated pin test that asserts coverage against the
 * upstream `KafkaJS.ConsumerGroupStates` enum.
 */
export const STATE_NAME_TO_ENUM: Readonly<
  Record<StateName, KafkaJS.ConsumerGroupStates>
> = {
  Unknown: KafkaJS.ConsumerGroupStates.UNKNOWN,
  PreparingRebalance: KafkaJS.ConsumerGroupStates.PREPARING_REBALANCE,
  CompletingRebalance: KafkaJS.ConsumerGroupStates.COMPLETING_REBALANCE,
  Stable: KafkaJS.ConsumerGroupStates.STABLE,
  Dead: KafkaJS.ConsumerGroupStates.DEAD,
  Empty: KafkaJS.ConsumerGroupStates.EMPTY,
};

/**
 * Zod-input name → numeric enum value forwarded to `admin.listGroups`.
 * Exported for the colocated pin test that asserts coverage against the
 * upstream `KafkaJS.ConsumerGroupTypes` enum (minus the UNKNOWN slot,
 * which is deliberately excluded from the input vocabulary).
 */
export const TYPE_NAME_TO_ENUM: Readonly<
  Record<TypeName, KafkaJS.ConsumerGroupTypes>
> = {
  Classic: KafkaJS.ConsumerGroupTypes.CLASSIC,
  Consumer: KafkaJS.ConsumerGroupTypes.CONSUMER,
};

/** Reverse of {@link STATE_NAME_TO_ENUM} for the response payload. */
const ENUM_TO_STATE_NAME: ReadonlyMap<KafkaJS.ConsumerGroupStates, StateName> =
  new Map(
    (
      Object.entries(STATE_NAME_TO_ENUM) as Array<
        [StateName, KafkaJS.ConsumerGroupStates]
      >
    ).map(([name, value]) => [value, name]),
  );

const ENUM_TO_TYPE_NAME: ReadonlyMap<KafkaJS.ConsumerGroupTypes, TypeName> =
  new Map(
    (
      Object.entries(TYPE_NAME_TO_ENUM) as Array<
        [TypeName, KafkaJS.ConsumerGroupTypes]
      >
    ).map(([name, value]) => [value, name]),
  );

export const listConsumerGroupsArgs = z.object({
  matchStates: z
    .array(z.enum(STATE_NAMES))
    .nonempty()
    .optional()
    .describe(
      "Restrict to groups currently in these states. Omit to return groups in any state. " +
        'Common filters: ["Stable"] for live consumers, ["Empty"] for orphaned groups.',
    ),
  matchType: z
    .enum(TYPE_NAMES)
    .optional()
    .describe(
      "Restrict to groups of this protocol type. Omit to return both types. " +
        '"Consumer" is the new KIP-848 protocol; "Classic" is the legacy generation-based one.',
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
        "Enumerate consumer groups on a Kafka cluster. Read-only — wraps " +
        "the broker's listGroups admin call. Optional matchStates / matchType " +
        "filters narrow the result server-side. Response carries one entry " +
        "per group ({groupId, state, type, protocolType, isSimpleConsumerGroup}) " +
        "plus an errors array carrying any per-broker partial failures.",
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

/**
 * Map a numeric librdkafka state enum back to the TitleCase wire string. An
 * unrecognized value is "Wacky --" territory — log it and fall through to
 * `"Unknown"` rather than synthesize a stringified number.
 */
function stateName(value: KafkaJS.ConsumerGroupStates): StateName {
  const name = ENUM_TO_STATE_NAME.get(value);
  if (name === undefined) {
    logger.warn(
      { value },
      "Wacky -- unrecognized ConsumerGroupStates numeric value from librdkafka; surfacing as 'Unknown'",
    );
    return "Unknown";
  }
  return name;
}

/**
 * Map a numeric librdkafka type enum back to the TitleCase wire string. The
 * librdkafka enum has an `UNKNOWN = 0` slot that is not part of the Zod
 * input vocabulary; surface it as the literal `"Unknown"` so callers see a
 * stable string rather than a number.
 */
function typeName(value: KafkaJS.ConsumerGroupTypes): string {
  if (value === KafkaJS.ConsumerGroupTypes.UNKNOWN) return "Unknown";
  const name = ENUM_TO_TYPE_NAME.get(value);
  if (name === undefined) {
    logger.warn(
      { value },
      "Wacky -- unrecognized ConsumerGroupTypes numeric value from librdkafka; surfacing as 'Unknown'",
    );
    return "Unknown";
  }
  return name;
}
