import { KafkaJS } from "@confluentinc/kafka-javascript";
import type {
  ITopicMetadata,
  KafkaMessage,
} from "@confluentinc/kafka-javascript/types/kafkajs.js";
import { SchemaRegistryClient, SerdeType } from "@confluentinc/schemaregistry";
import {
  deserializeMessage,
  getLatestSchemaIfExists,
} from "@src/confluent/schema-registry-helper.js";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  READ_ONLY,
  ToolCategory,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import {
  disposeIfOAuth,
  formatKafkaError,
  resolveKafkaClusterArgs,
} from "@src/confluent/tools/cluster-arg-resolvers.js";
import { kafkaBootstrapOrOAuth } from "@src/confluent/tools/connection-predicates.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { logger } from "@src/logger.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { z } from "zod";

const messageOptions = z.object({
  useSchemaRegistry: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Whether to use schema registry for deserialization. If false, messages will be returned as raw.",
    ),
  subject: z
    .string()
    .optional()
    .describe(
      "Schema registry subject. Defaults to 'topicName-value' or 'topicName-key'.",
    ),
});

const valueOptions = z.object({}).extend(messageOptions.shape);
const keyOptions = z.object({}).extend(messageOptions.shape);

type ValueOptions = z.infer<typeof valueOptions>;
type KeyOptions = z.infer<typeof keyOptions>;

/**
 * Per-topic consume options. Lets callers restrict consumption to a
 * specific partition and/or seek to a specific starting position within
 * that partition. Use the parent {@link consumeKafkaMessagesArgs}'s
 * `topics` array; pass a bare {@link consumeKafkaMessagesArgs.topicNames}
 * list when no per-topic overrides are needed.
 */
const topicConsumeOptions = z
  .object({
    topicName: z
      .string()
      .min(1)
      .describe("Name of the Kafka topic to consume from."),
    partition: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Restrict consumption to this partition (0-indexed). Other " +
          "partitions in the topic are paused after assignment. Omit " +
          "to consume all partitions of the topic.",
      ),
    offset: z
      .string()
      .regex(
        /^\d+$/,
        "offset must be a non-negative integer (digit-only string)",
      )
      .optional()
      .describe(
        "Absolute starting offset within the partition. Kafka offsets " +
          "are int64; pass as a string to preserve precision beyond JS's " +
          "2^53 safe-integer range. Mutually exclusive with `timestamp`.",
      ),
    timestamp: z
      .union([
        z.string().datetime({ offset: true }),
        z.number().int().positive(),
      ])
      .optional()
      .describe(
        "Start consuming from this point in time. ISO 8601 preferred " +
          '(e.g. "2026-05-14T17:00:00Z" or "2026-05-14T13:00:00-04:00"); ' +
          "ms-since-epoch accepted as an escape hatch for programmatic " +
          "callers. Resolved to a partition offset server-side via " +
          "fetchTopicOffsetsByTimestamp. Mutually exclusive with `offset`.",
      ),
  })
  .superRefine((data, ctx) => {
    if (data.offset !== undefined && data.timestamp !== undefined) {
      ctx.addIssue({
        code: "custom",
        message:
          "Specify only one of `offset` or `timestamp` per topic entry, not both.",
        path: [],
      });
    }
  });

export const consumeKafkaMessagesArgs = z
  .object({
    topicNames: z
      .array(z.string())
      .nonempty()
      .optional()
      .describe(
        "Simple list of Kafka topic names. Use when no per-topic " +
          "partition/offset/timestamp overrides are needed. Mutually " +
          "exclusive with `topics`.",
      ),
    topics: z
      .array(topicConsumeOptions)
      .nonempty()
      .optional()
      .describe(
        "Per-topic consume options. Use when restricting partitions " +
          "or seeking by offset/timestamp on individual topics. " +
          "Mutually exclusive with `topicNames`.",
      ),
    maxMessages: z
      .number()
      .int()
      .positive()
      .optional()
      .default(10)
      .describe("Maximum number of messages to consume before stopping."),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .default(10000)
      .describe(
        "Maximum time in milliseconds to wait for messages before stopping.",
      ),
    offsetReset: z
      .enum(["earliest", "latest", "none"])
      .optional()
      .default("latest")
      .describe(
        "Starting position when no committed offset exists: 'latest' " +
          "(default) reads only newly-produced messages from the partition " +
          "high watermark; 'earliest' reads from the partition low watermark " +
          "(the entire retained history); 'none' fails rather than auto-pick, " +
          "useful when the caller plans to seek to a specific offset and " +
          "wants a loud error if that seek doesn't take effect.",
      ),
    value: valueOptions,
    key: keyOptions.optional(),
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
  })
  .superRefine((data, ctx) => {
    const hasTopicNames =
      data.topicNames !== undefined && data.topicNames.length > 0;
    const hasTopics = data.topics !== undefined && data.topics.length > 0;
    if (hasTopicNames && hasTopics) {
      ctx.addIssue({
        code: "custom",
        message:
          "Specify exactly one of `topicNames` (simple list) or `topics` (per-topic overrides), not both.",
        path: [],
      });
    } else if (!hasTopicNames && !hasTopics) {
      ctx.addIssue({
        code: "custom",
        message:
          "Specify either `topicNames` (simple list of topics) or `topics` (per-topic partition/offset/timestamp overrides).",
        path: [],
      });
    }
  });

interface ProcessedMessage {
  key: unknown;
  value: unknown;
  timestamp: string;
  offset: string;
  headers?: Record<string, string>;
  topic: string;
  partition: number;
}

/**
 * Internal normalized form for the per-topic consume options, used by the
 * pre-flight and seek/pause helpers. Either branch of the tool's input
 * (`topicNames` or `topics`) collapses into a list of these.
 */
interface NormalizedTopicTarget {
  topicName: string;
  partition?: number;
  /** Digit-only string, already validated by Zod. */
  offset?: string;
  /** ms-since-epoch; ISO 8601 inputs are normalized at the boundary. */
  timestampMs?: number;
}

/**
 * Result of {@link buildPreflightPlan}: the canonical list of topics to
 * subscribe to plus the partition-keep set and per-partition seek targets
 * that {@link applySeekAndPause} will apply after the consumer assignment
 * lands.
 */
interface PreflightPlan {
  /** Unique topic names to subscribe to (deduplicated across entries). */
  topicNames: string[];
  /**
   * If a topic appears here, only the listed partitions are kept active;
   * any other partition the broker assigns is paused. Absent topic means
   * "keep every assigned partition for that topic."
   */
  keepPartitions: Map<string, Set<number>>;
  /** Per-(topic, partition) seek targets. */
  seeks: { topic: string; partition: number; offset: string }[];
}

/**
 * Normalize the parsed tool args into a uniform list of per-topic targets.
 * `topicNames` callers get bare entries (no partition/offset/timestamp);
 * `topics` callers get their entries through with ISO 8601 timestamps
 * converted to ms-since-epoch so downstream code only sees numbers.
 */
function normalizeTopicTargets(
  parsed: z.infer<typeof consumeKafkaMessagesArgs>,
): NormalizedTopicTarget[] {
  if (parsed.topicNames !== undefined) {
    return parsed.topicNames.map((topicName) => ({ topicName }));
  }
  // Zod's xor refinement guarantees `topics` is populated here.
  return parsed.topics!.map((entry) => ({
    topicName: entry.topicName,
    partition: entry.partition,
    offset: entry.offset,
    timestampMs:
      entry.timestamp === undefined
        ? undefined
        : typeof entry.timestamp === "number"
          ? entry.timestamp
          : Date.parse(entry.timestamp),
  }));
}

/**
 * Returns true when any target carries a partition restriction or seek
 * target — i.e. when the handler needs to build an admin client and run
 * pre-flight + post-assignment seek/pause. Plain `topicNames` calls skip
 * the whole dance.
 */
function planNeedsPreflight(targets: NormalizedTopicTarget[]): boolean {
  return targets.some(
    (t) =>
      t.partition !== undefined ||
      t.offset !== undefined ||
      t.timestampMs !== undefined,
  );
}

/**
 * Validates the requested targets against broker metadata and watermarks,
 * resolves any timestamp-based seeks to concrete partition offsets, and
 * produces the canonical {@link PreflightPlan}. Thrown errors are caught
 * one frame up and rendered as a tool-error response.
 *
 * Validation rules (handler-side; the Zod schema covers field-level shape):
 * - `offset` requires `partition` — absolute offsets are partition-scoped;
 *   different partitions have different offset spaces.
 * - All-or-nothing partition mode per topic: every entry for a given
 *   topic must specify `partition`, or none of them may. Mixing is
 *   ambiguous (does the bare entry override the partitioned one or
 *   coexist with it?) and rejected loudly.
 * - Requested partitions must exist (cross-check with
 *   `admin.fetchTopicMetadata`).
 * - Absolute offsets must lie in `[low, high)` for their partition
 *   (cross-check with `admin.fetchTopicOffsets`).
 */
async function buildPreflightPlan(
  admin: KafkaJS.Admin,
  targets: NormalizedTopicTarget[],
): Promise<PreflightPlan> {
  for (const t of targets) {
    if (t.offset !== undefined && t.partition === undefined) {
      throw new Error(
        `Topic "${t.topicName}" has an explicit offset (${t.offset}) but no partition. ` +
          `Absolute offsets are partition-scoped — different partitions have different offset spaces. ` +
          `Either also supply a partition for this entry, or use timestamp (which resolves per-partition).`,
      );
    }
  }

  const byTopic = new Map<string, NormalizedTopicTarget[]>();
  for (const t of targets) {
    let list = byTopic.get(t.topicName);
    if (!list) {
      list = [];
      byTopic.set(t.topicName, list);
    }
    list.push(t);
  }
  const topicNames = [...byTopic.keys()];

  const metadataRaw = await admin.fetchTopicMetadata({ topics: topicNames });
  // The @confluentinc/kafka-javascript .d.ts declares this call as
  // `Promise<{ topics: Array<ITopicMetadata> }>` but the runtime
  // implementation returns the bare `Array<ITopicMetadata>` — long-standing
  // mismatch tracked at confluentinc/confluent-kafka-javascript#367.
  // Normalize defensively so either shape works if the library ever fixes
  // its type declaration.
  const topicMetadata: ITopicMetadata[] = Array.isArray(metadataRaw)
    ? (metadataRaw as unknown as ITopicMetadata[])
    : metadataRaw.topics;
  const numPartitionsByTopic = new Map<string, number>();
  for (const t of topicMetadata) {
    numPartitionsByTopic.set(t.name, t.partitions.length);
  }
  for (const name of topicNames) {
    if (!numPartitionsByTopic.has(name)) {
      throw new Error(
        `Topic "${name}" returned no partition metadata (does it exist on this cluster?).`,
      );
    }
  }

  for (const t of targets) {
    if (t.partition !== undefined) {
      const numParts = numPartitionsByTopic.get(t.topicName)!;
      if (t.partition >= numParts) {
        throw new Error(
          `Topic "${t.topicName}" has ${numParts} partition(s) (0..${numParts - 1}); ` +
            `requested partition ${t.partition} is out of range.`,
        );
      }
    }
  }

  const keepPartitions = new Map<string, Set<number>>();
  for (const [topic, list] of byTopic) {
    const explicit = list
      .map((t) => t.partition)
      .filter((p): p is number => p !== undefined);
    if (explicit.length === list.length) {
      keepPartitions.set(topic, new Set(explicit));
    } else if (explicit.length > 0) {
      throw new Error(
        `Topic "${topic}" mixes entries with explicit partitions and entries without one. ` +
          `Pick one mode per topic: either every entry restricts to a partition, or none do.`,
      );
    }
    // explicit.length === 0 → no restriction; keepPartitions omits the topic.
  }

  const seeks: PreflightPlan["seeks"] = [];
  for (const t of targets) {
    if (t.offset !== undefined && t.partition !== undefined) {
      const offsets = await admin.fetchTopicOffsets(t.topicName);
      const partOffsets = offsets.find((o) => o.partition === t.partition);
      if (!partOffsets) {
        throw new Error(
          `Topic "${t.topicName}" partition ${t.partition} returned no offset metadata.`,
        );
      }
      const low = BigInt(partOffsets.low);
      const high = BigInt(partOffsets.high);
      const target = BigInt(t.offset);
      if (target < low || target >= high) {
        throw new Error(
          `Topic "${t.topicName}" partition ${t.partition} offset ${t.offset} is out of range ` +
            `[low=${partOffsets.low}, high=${partOffsets.high}). ` +
            `An empty partition has low === high; pick an offset already on the partition.`,
        );
      }
      seeks.push({
        topic: t.topicName,
        partition: t.partition,
        offset: t.offset,
      });
    } else if (t.timestampMs !== undefined) {
      const resolved = await admin.fetchTopicOffsetsByTimestamp(
        t.topicName,
        t.timestampMs,
      );
      const candidates =
        t.partition !== undefined
          ? resolved.filter((r) => r.partition === t.partition)
          : resolved;
      for (const r of candidates) {
        seeks.push({
          topic: t.topicName,
          partition: r.partition,
          offset: r.offset,
        });
      }
    }
  }

  return { topicNames, keepPartitions, seeks };
}

/**
 * Poll `consumer.assignment()` until it returns a non-empty array or the
 * supplied deadline passes. Returns the assignment, or `null` if the
 * deadline was hit first. The kafkajs-compat consumer only populates its
 * assignment after `consumer.run()` triggers the first poll, so this is
 * the well-defined seam to wait on before issuing per-partition seeks.
 */
async function waitForAssignment(
  consumer: KafkaJS.Consumer,
  deadline: number,
): Promise<{ topic: string; partition: number }[] | null> {
  for (;;) {
    const assignment = consumer.assignment();
    if (assignment.length > 0) {
      return assignment;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await new Promise<void>((r) => setTimeout(r, 50));
  }
}

/**
 * After the consumer assignment lands, pause any assigned partition that
 * isn't in the keep-set and seek each per-partition target to its
 * resolved offset.
 */
async function applySeekAndPause(
  consumer: KafkaJS.Consumer,
  plan: PreflightPlan,
  assignment: { topic: string; partition: number }[],
): Promise<void> {
  const toPause: { topic: string; partitions: number[] }[] = [];
  for (const [topic, keepSet] of plan.keepPartitions) {
    const pauseForTopic = assignment
      .filter((a) => a.topic === topic && !keepSet.has(a.partition))
      .map((a) => a.partition);
    if (pauseForTopic.length > 0) {
      toPause.push({ topic, partitions: pauseForTopic });
    }
  }
  if (toPause.length > 0) {
    consumer.pause(toPause);
  }

  for (const s of plan.seeks) {
    consumer.seek({ topic: s.topic, partition: s.partition, offset: s.offset });
  }
}

/**
 * Handler for consuming messages from Kafka topics with support for Schema Registry deserialization.
 * This handler allows consuming messages from one or more topics with configurable message limits and timeouts.
 * It supports automatic deserialization of Schema Registry encoded messages (AVRO, JSON, PROTOBUF).
 */
export class ConsumeKafkaMessagesHandler extends BaseToolHandler {
  /**
   * Processes a single Kafka message, handling deserialization of both key and value.
   * @param topic - The topic the message was consumed from
   * @param partition - The partition the message was consumed from
   * @param message - The raw Kafka message
   * @param registry - Optional Schema Registry client for deserialization
   * @param valueOptions - Options for value deserialization
   * @param keyOptions - Optional options for key deserialization
   * @returns A processed message with deserialized key and value
   */
  async processMessage(
    topic: string,
    partition: number,
    message: KafkaMessage,
    registry: SchemaRegistryClient | undefined,
    valueOptions: ValueOptions,
    keyOptions?: KeyOptions,
  ): Promise<ProcessedMessage> {
    let processedKey: unknown = message.key?.toString();
    let processedValue: unknown = message.value?.toString();

    const deserializeWithOptions = async (
      buffer: Buffer | undefined,
      options: ValueOptions | KeyOptions,
      serdeType: SerdeType,
    ): Promise<unknown> => {
      if (!options.useSchemaRegistry || !registry) {
        return buffer?.toString();
      }
      const subject =
        options.subject ||
        `${topic}-${serdeType === SerdeType.KEY ? "key" : "value"}`;
      const schema = await getLatestSchemaIfExists(registry, subject);
      if (!schema || !schema.schemaType) {
        return buffer?.toString();
      }
      try {
        return await deserializeMessage(
          topic,
          buffer as Buffer,
          schema.schemaType,
          registry,
          serdeType,
        );
      } catch (err) {
        logger.error(
          { error: err, topic, schemaType: schema.schemaType, serdeType },
          `Error deserializing message ${serdeType} for topic ${topic}`,
        );
        return buffer?.toString();
      }
    };

    processedValue = await deserializeWithOptions(
      message.value as Buffer,
      valueOptions,
      SerdeType.VALUE,
    );
    if (message.key && keyOptions) {
      processedKey = await deserializeWithOptions(
        message.key as Buffer,
        keyOptions,
        SerdeType.KEY,
      );
    }

    return {
      key: processedKey,
      value: processedValue,
      timestamp: message.timestamp,
      offset: message.offset,
      headers: message.headers
        ? Object.fromEntries(
            Object.entries(message.headers).map(([key, value]) => [
              key,
              value?.toString() || "",
            ]),
          )
        : undefined,
      topic,
      partition,
    };
  }

  /**
   * Main handler for consuming messages from Kafka topics.
   * @param clientManager - The client manager for Kafka and registry clients
   * @param toolArguments - The arguments for the tool, including topics, message limits, and deserialization options
   * @param sessionId - Optional session ID for Kafka consumer
   * @returns A CallToolResult containing the consumed messages or error information
   */
  async handle(
    runtime: ServerRuntime,
    toolArguments: z.infer<typeof consumeKafkaMessagesArgs>,
    sessionId?: string,
  ): Promise<CallToolResult> {
    const parsed = consumeKafkaMessagesArgs.parse(toolArguments);
    const { maxMessages, timeoutMs, value, key, offsetReset } = parsed;

    const { connId, clientManager } = this.resolveSoleConnection(runtime);
    const resolved = resolveKafkaClusterArgs(parsed, runtime, connId);

    const needsRegistry =
      (value && value.useSchemaRegistry) || (key && key.useSchemaRegistry);

    let registry: SchemaRegistryClient | undefined;
    if (needsRegistry) {
      registry = await clientManager.getSchemaRegistrySdkClient(resolved.envId);
    }

    const targets = normalizeTopicTargets(parsed);
    const needsPreflight = planNeedsPreflight(targets);

    let plan: PreflightPlan;
    if (needsPreflight) {
      const admin = await clientManager.getKafkaAdminClient(
        resolved.clusterId,
        resolved.envId,
      );
      try {
        plan = await buildPreflightPlan(admin, targets);
      } catch (error: unknown) {
        return this.createResponse(
          `Failed to consume messages: ${formatKafkaError(error)}`,
          true,
        );
      } finally {
        await disposeIfOAuth(runtime, connId, admin);
      }
    } else {
      plan = {
        topicNames: [...new Set(targets.map((t) => t.topicName))],
        keepPartitions: new Map(),
        seeks: [],
      };
    }

    const consumedMessages: ProcessedMessage[] = [];
    let timeoutReached = false;
    // When the plan has no seeks/pauses, every message coming in via
    // eachMessage is "post-seek" by definition — start counting immediately.
    let seekApplied = !needsPreflight;
    let consumer: KafkaJS.Consumer | undefined;

    try {
      consumer = await clientManager.buildKafkaConsumer({
        clusterId: resolved.clusterId,
        envId: resolved.envId,
        groupId: sessionId,
        offsetReset,
      });
      await consumer.connect();
      await consumer.subscribe({ topics: plan.topicNames });

      const deadline = Date.now() + timeoutMs;

      const consumePromise = new Promise<void>((resolve, reject) => {
        if (!consumer) {
          reject(new Error("Consumer was unexpectedly undefined"));
          return;
        }
        consumer
          .run({
            eachMessage: async ({ topic, partition, message }) => {
              if (timeoutReached) return;
              // Drop messages that arrive before the seek/pause dance has
              // run; they're from the consumer's pre-seek fetch buffer and
              // don't reflect the requested starting position.
              if (!seekApplied) return;
              const processed = await this.processMessage(
                topic,
                partition,
                message,
                registry,
                value,
                key,
              );
              consumedMessages.push(processed);
              if (consumedMessages.length >= maxMessages) {
                timeoutReached = true;
                resolve();
              }
            },
          })
          .catch((error) => {
            reject(error);
          });
        setTimeout(() => {
          timeoutReached = true;
          resolve();
        }, timeoutMs);

        if (needsPreflight) {
          (async () => {
            const assignment = await waitForAssignment(consumer!, deadline);
            if (!assignment) {
              // timeoutMs elapsed before the consumer received any
              // partition assignment — we'll return 0 messages with the
              // normal timeout path. The setTimeout above will also fire.
              timeoutReached = true;
              resolve();
              return;
            }
            await applySeekAndPause(consumer!, plan, assignment);
            seekApplied = true;
          })().catch((error) => {
            reject(error);
          });
        }
      });

      await consumePromise;

      return this.createResponse(
        `Consumed ${consumedMessages.length} messages from topics ${plan.topicNames.join(", ")}.\nConsumed messages: ${JSON.stringify(consumedMessages, null, 2)}`,
        false,
      );
    } catch (error: unknown) {
      return this.createResponse(
        `Failed to consume messages: ${formatKafkaError(error)}`,
        true,
      );
    } finally {
      if (consumer) {
        try {
          await consumer.disconnect();
        } catch (error) {
          logger.error({ error }, "Error cleaning up consumer");
        }
      }
    }
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.CONSUME_MESSAGES,
      description:
        "Consumes messages from one or more Kafka topics. Supports automatic deserialization of Schema Registry encoded messages (AVRO, JSON, PROTOBUF).",
      inputSchema: consumeKafkaMessagesArgs.shape,
      annotations: READ_ONLY,
    };
  }

  readonly category = ToolCategory.Kafka;
  readonly predicate = kafkaBootstrapOrOAuth;
}
