import { KafkaJS } from "@confluentinc/kafka-javascript";
import type {
  ITopicMetadata,
  KafkaMessage,
} from "@confluentinc/kafka-javascript/types/kafkajs.js";
import { SchemaRegistryClient, SerdeType } from "@confluentinc/schemaregistry";
import { nodeCrypto } from "@src/confluent/node-deps.js";
import * as schemaRegistryHelper from "@src/confluent/schema-registry-helper.js";
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
import {
  hasSchemaRegistryOrOAuth,
  kafkaBootstrapOrOAuth,
} from "@src/confluent/tools/connection-predicates.js";
import {
  createWatermarkCache,
  type WatermarkCache,
} from "@src/confluent/tools/handlers/kafka/partition-offsets.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { logger } from "@src/logger.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { z } from "zod";

const schemaRegistryOptions = z
  .object({
    disableSchemaRegistry: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Set to true to skip Schema Registry decoding and return raw UTF-8 bytes. " +
          "When false (the default), messages are auto-decoded via the registered " +
          "AVRO / JSON / PROTOBUF schema if the connection has Schema Registry " +
          "configured and a schema exists for the subject; otherwise left as raw bytes.",
      ),
    subject: z
      .string()
      .optional()
      .describe(
        "Schema registry subject. Defaults to '<topic>-value' or '<topic>-key'.",
      ),
  })
  // The optional() + default() wrapping lives here on the shared
  // schema so `valueFormat` and `keyFormat` declarations downstream
  // are bare references — one place to change if the omit-by-default
  // contract ever evolves.
  .optional()
  .default({ disableSchemaRegistry: false });

// `ValueOptions` and `KeyOptions` are structurally identical to
// `schemaRegistryOptions` — they exist as named types only to make the
// value-side vs key-side distinction explicit at `processMessage`'s
// signature. The schema fields below use `schemaRegistryOptions` directly;
// no separate runtime schema is needed for each side.
type ValueOptions = z.infer<typeof schemaRegistryOptions>;
type KeyOptions = z.infer<typeof schemaRegistryOptions>;

/**
 * Per-entry "where to start consuming" tagged union. Collapses the prior
 * `offset` and `timestamp` peer fields plus the top-level `offsetReset`
 * knob into a single per-topic position control with five arms:
 *
 *   - `"earliest"` — begin at the partition low watermark (entire retained
 *     history). This is the default when `start` is omitted.
 *   - `"latest"` — begin at the partition high watermark (only
 *     newly-produced messages).
 *   - `{ offset: "..." }` — begin at an absolute partition offset
 *     (digit-only string; requires `partition`).
 *   - `{ timestamp: ... }` — begin at the broker-resolved offset for the
 *     supplied time (ISO 8601 preferred; ms-since-epoch also accepted).
 *   - `{ tail: N }` — begin at `max(low, high - N)` on the partition, so
 *     the consumer returns up to the last N already-written messages
 *     without waiting for new traffic (requires `partition`).
 *
 * The object arms are `strictObject` so `{offset, timestamp}`,
 * `{tail, offset}`, etc. together are a union miss rather than a silent
 * strip of one key.
 */
const startOption = z
  .union([
    z.literal("earliest"),
    z.literal("latest"),
    z.strictObject({
      offset: z
        .string()
        .regex(
          /^\d+$/,
          "offset must be a non-negative integer (digit-only string)",
        )
        .describe(
          "Absolute starting offset within the partition, as a digit-only string.",
        ),
    }),
    z.strictObject({
      timestamp: z
        .union([
          z.iso.datetime({ offset: true }),
          z.number().int().nonnegative(),
        ])
        .describe(
          'ISO 8601 timestamp (e.g. "2026-05-14T17:00:00Z" or ' +
            '"2026-05-14T13:00:00-04:00") or ms-since-epoch number. The ' +
            "broker resolves this to a per-partition offset.",
        ),
    }),
    z.strictObject({
      tail: z
        .number()
        .int()
        .positive()
        .describe(
          "Consume the most recent N already-written messages from this partition. " +
            "REQUIRES `partition` to be set on the same topic entry — there " +
            "is no implicit partition default; consumption is " +
            "single-partition only. N must be a positive integer. The " +
            "consumer seeks to max(lowWatermark, highWatermark - N) and " +
            "returns immediately with whatever is already there — it does " +
            "not block waiting for new writes.",
        ),
    }),
  ])
  .describe(
    "Where to begin consuming this topic. Use 'earliest' for the entire " +
      "retained history; 'latest' for " +
      "newly-produced messages only; {offset: 'N'} for an absolute " +
      "partition offset (requires `partition`); {timestamp: '...'} " +
      "to seek to the broker-resolved offset for a point in time; or " +
      "{tail: N} for the last N already-written messages on the " +
      "partition (requires `partition`, returns without waiting for new " +
      "traffic).",
  );

/**
 * Per-topic consume options. `name` is the only required field. `partition`
 * optionally restricts to one partition; `start` optionally picks the
 * starting position. Both are independent — `partition` answers WHICH
 * partition(s), `start` answers WHERE in them to begin.
 */
const topicConsumeOptions = z.object({
  name: z.string().min(1).describe("Kafka topic name to consume from."),
  partition: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "Optional. Restrict consumption to this partition (0-indexed). " +
        "Other partitions in the topic are paused after assignment. " +
        "Omit to consume all partitions of the topic.",
    ),
  start: startOption.optional().default("earliest"),
});

export const consumeKafkaMessagesArgs = z.object({
  topics: z
    .array(topicConsumeOptions)
    .nonempty()
    .describe(
      "Topics to consume from. Each entry is an object with at least " +
        "`name` (the Kafka topic name). Example simple call: " +
        '[{name: "orders"}]. The `partition` and `start` fields let ' +
        "callers restrict to a specific partition and/or pick where in " +
        "the topic to begin consuming (e.g. " +
        '[{name: "orders", partition: 0, start: {offset: "42"}}], ' +
        '[{name: "orders", start: {timestamp: "2026-05-14T17:00:00Z"}}]).',
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
  valueFormat: schemaRegistryOptions.describe(
    "VALUE format. Default: auto-decode via Schema Registry when configured. " +
      "Set `disableSchemaRegistry: true` for raw UTF-8.",
  ),
  keyFormat: schemaRegistryOptions.describe(
    "KEY format. Default: auto-decode via Schema Registry when configured. " +
      "Set `disableSchemaRegistry: true` for raw UTF-8.",
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

export interface ProcessedMessage {
  key: unknown;
  value: unknown;
  /**
   * Message timestamp, normalized by {@link formatMessageTimestamp}.
   * Usual case: an ISO 8601 UTC string like `"2026-03-01T17:00:00.000Z"`
   * — surfaced in this format so an LLM consumer can immediately spot
   * mismatches between a requested `start: {timestamp}` filter and the
   * delivered records (ms-since-epoch makes such drift invisible
   * without arithmetic). Two non-ISO outcomes are possible:
   *
   * - The literal sentinel `"(no timestamp)"` when the underlying
   *   Kafka message has no timestamp (Kafka's `-1` sentinel for
   *   pre-0.10.0 message formats, or any record whose producer didn't
   *   set one).
   * - The raw input string passed through unchanged when
   *   `Number(input)` is non-finite — a defensive escape hatch for
   *   degenerate library inputs.
   */
  timestamp: string;
  offset: string;
  headers?: Record<string, string>;
  topic: string;
  partition: number;
}

/**
 * Format a Kafka message's `message.timestamp` (a string of ms-since-epoch
 * per kafkajs) into an ISO 8601 UTC string. Returns `"(no timestamp)"` for
 * undefined or Kafka's `-1` sentinel (message format pre-0.10.0 or
 * timestamp unset by the producer). Exported for direct unit-test coverage
 * of the four branches plus the empty-string edge case (`Number("")` is
 * `0`, which is finite, so an empty timestamp string formats as epoch).
 */
export function formatMessageTimestamp(ts: string | undefined): string {
  if (ts === undefined || ts === "-1") return "(no timestamp)";
  const ms = Number(ts);
  if (!Number.isFinite(ms)) return ts;
  return new Date(ms).toISOString();
}

/**
 * Internal normalized form for the per-topic consume options. Each parsed
 * `topics` entry's `start` union collapses into one of these tagged
 * variants so downstream code switches on `start.kind` instead of probing
 * for which optional field happens to be set.
 */
type NormalizedStart =
  | { kind: "earliest" }
  | { kind: "latest" }
  | { kind: "offset"; value: string }
  | { kind: "timestamp"; ms: number }
  | { kind: "tail"; count: number };

interface NormalizedTopicTarget {
  name: string;
  partition?: number;
  start: NormalizedStart;
}

/**
 * Result of {@link buildPreflightPlan}: the canonical list of topics to
 * subscribe to plus the partition-keep set and per-partition seek targets
 * that the post-assignment dance will apply.
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
 * Collapse the parsed `start` union into the internal tagged form.
 * ISO 8601 timestamps normalize to ms-since-epoch at this boundary so
 * downstream code only sees numbers. Exported so the timestamp-arm's
 * string-vs-number branch can be unit-tested directly (the handler-level
 * tests only exercise the string path).
 */
export function normalizeStart(
  start: z.infer<typeof topicConsumeOptions>["start"],
): NormalizedStart {
  if (start === "earliest") return { kind: "earliest" };
  if (start === "latest") return { kind: "latest" };
  if ("offset" in start) return { kind: "offset", value: start.offset };
  if ("tail" in start) return { kind: "tail", count: start.tail };
  return {
    kind: "timestamp",
    ms:
      typeof start.timestamp === "number"
        ? start.timestamp
        : Date.parse(start.timestamp),
  };
}

/**
 * Normalize the parsed tool args into a uniform list of per-topic targets.
 */
function normalizeTopicTargets(
  parsed: z.infer<typeof consumeKafkaMessagesArgs>,
): NormalizedTopicTarget[] {
  return parsed.topics.map((entry) => ({
    name: entry.name,
    partition: entry.partition,
    start: normalizeStart(entry.start),
  }));
}

/**
 * Pick the consumer's `auto.offset.reset` value from the call. The
 * consumer-wide setting governs any partition that doesn't get an
 * explicit seek — so we want to align it with the call's intent and
 * avoid emitting watermark seeks unnecessarily.
 *
 * Rule: if every direction-only entry (`start: "earliest"` or
 * `start: "latest"`) agrees on `"earliest"`, use `"earliest"`; otherwise
 * use `"latest"`. The choice of `"latest"` as the mixed-direction
 * tiebreaker matches librdkafka's own `auto.offset.reset` default and
 * keeps the explicit-seek work localized to the `"earliest"` minority
 * (which gets per-partition low-watermark seeks during preflight); the
 * `"latest"` majority inherits the consumer-wide default and needs no
 * extra admin round-trips.
 */
function deriveConsumerOffsetReset(
  targets: NormalizedTopicTarget[],
): "earliest" | "latest" {
  const directions = targets
    .map((t) =>
      t.start.kind === "earliest" || t.start.kind === "latest"
        ? t.start.kind
        : null,
    )
    .filter((d): d is "earliest" | "latest" => d !== null);
  if (directions.length > 0 && directions.every((d) => d === "earliest")) {
    return "earliest";
  }
  return "latest";
}

/**
 * Returns true when any target requires the admin pre-flight + seek/pause
 * dance. Bare-name-only calls (no partition restrictions, no explicit
 * offset/timestamp/tail seeks, and a `start` whose direction matches the
 * consumer's chosen reset) skip the whole dance — the consumer's
 * `auto.offset.reset` handles them naturally.
 */
function planNeedsPreflight(
  targets: NormalizedTopicTarget[],
  consumerOffsetReset: "earliest" | "latest",
): boolean {
  return targets.some(
    (t) =>
      t.partition !== undefined ||
      t.start.kind === "offset" ||
      t.start.kind === "timestamp" ||
      t.start.kind === "tail" ||
      (t.start.kind === "earliest" && consumerOffsetReset === "latest"),
  );
}

/**
 * Reject any target whose `start` arm is partition-scoped but supplies
 * no `partition`. Both `{offset}` and `{tail}` need partition context
 * (different partitions have different offset spaces and different
 * message counts), so picking a default is footgun-prone; rejecting at
 * the boundary is louder.
 */
function guardScopedStartRequiresPartition(
  targets: NormalizedTopicTarget[],
): void {
  for (const t of targets) {
    if (t.start.kind === "offset" && t.partition === undefined) {
      throw new Error(
        `Topic "${t.name}" has an explicit offset (${t.start.value}) but no partition. ` +
          `Absolute offsets are partition-scoped — different partitions have different offset spaces. ` +
          `Either also supply a partition for this entry, or use a timestamp (which resolves per-partition).`,
      );
    }
    if (t.start.kind === "tail" && t.partition === undefined) {
      throw new Error(
        `Topic "${t.name}" requested tail of ${t.start.count} messages but no partition. ` +
          `Tail is partition-scoped — different partitions have different message counts, and ` +
          `cross-partition freshness ordering is not defined for this tool. ` +
          `Supply a partition for this entry.`,
      );
    }
  }
}

/**
 * Group targets by topic name preserving entry order. Used downstream
 * for both the all-or-nothing partition-mode check and the keep-set
 * derivation; computing it once means subsequent iterations stay O(N).
 */
/**
 * Fetch partition counts for the supplied topics via
 * `admin.fetchTopicMetadata`. Throws if any requested topic returned no
 * metadata (typically: the topic doesn't exist on this cluster).
 *
 * Defensive shape normalization: the `@confluentinc/kafka-javascript`
 * `.d.ts` declares this call as `Promise<{ topics: Array<ITopicMetadata> }>`
 * but the runtime implementation returns the bare `Array<ITopicMetadata>`
 * — long-standing mismatch tracked at
 * confluentinc/confluent-kafka-javascript#367. Handle either shape so a
 * future library fix doesn't require code change here.
 */
async function fetchPartitionCounts(
  admin: KafkaJS.Admin,
  topicNames: string[],
): Promise<Map<string, number>> {
  const metadataRaw = await admin.fetchTopicMetadata({ topics: topicNames });
  const topicMetadata: ITopicMetadata[] = Array.isArray(metadataRaw)
    ? (metadataRaw as unknown as ITopicMetadata[])
    : metadataRaw.topics;
  const counts = new Map<string, number>();
  for (const t of topicMetadata) {
    counts.set(t.name, t.partitions.length);
  }
  for (const name of topicNames) {
    if (!counts.has(name)) {
      throw new Error(
        `Topic "${name}" returned no partition metadata (does it exist on this cluster?).`,
      );
    }
  }
  return counts;
}

/**
 * Reject any target whose `partition` index is out of range for its
 * topic. The error message cites the actual partition count so the
 * caller can correct without guessing.
 */
function validateRequestedPartitions(
  targets: NormalizedTopicTarget[],
  numPartitionsByTopic: Map<string, number>,
): void {
  for (const t of targets) {
    if (t.partition !== undefined) {
      const numParts = numPartitionsByTopic.get(t.name)!;
      if (t.partition >= numParts) {
        throw new Error(
          `Topic "${t.name}" has ${numParts} partition(s) (0..${numParts - 1}); ` +
            `requested partition ${t.partition} is out of range.`,
        );
      }
    }
  }
}

/**
 * Validate per-topic consistency and derive the keep-partitions map in
 * a single pass over `byTopic`. Three rejections fire here, each a
 * shape of "starting position is ambiguous" the consumer can't honor:
 *
 *  - **Mixed mode**: a topic with some entries restricting to a partition
 *    and others not — does the bare entry coexist with or override the
 *    partitioned one? Reject loudly.
 *  - **Duplicate unrestricted**: a topic with multiple entries that all
 *    omit `partition`. Two "every partition" entries with conflicting
 *    `start` directions silently let one win the seek/reset race; reject.
 *  - **Duplicate (topic, partition)**: the same partition index referenced
 *    twice within one topic — same ambiguity at finer granularity.
 *
 * Topics whose entries are all unrestricted are omitted from the
 * returned map (downstream: "keep every assigned partition for that
 * topic"). For topics that restrict, the keep-set is exactly the
 * requested partition indices.
 */
function validateAndBuildKeepPartitions(
  byTopic: Map<string, NormalizedTopicTarget[]>,
): Map<string, Set<number>> {
  const keepPartitions = new Map<string, Set<number>>();
  for (const [topic, list] of byTopic) {
    const explicit = list
      .map((t) => t.partition)
      .filter((p): p is number => p !== undefined);
    const allPartitioned = explicit.length === list.length;
    const nonePartitioned = explicit.length === 0;
    if (!allPartitioned && !nonePartitioned) {
      throw new Error(
        `Topic "${topic}" mixes entries with explicit partitions and entries without one. ` +
          `Pick one mode per topic: either every entry restricts to a partition, or none do.`,
      );
    }
    if (nonePartitioned) {
      if (list.length > 1) {
        throw new Error(
          `Topic "${topic}" has ${list.length} entries without partition restrictions; ` +
            `specify each topic at most once at the unrestricted level (or restrict each entry to a distinct partition).`,
        );
      }
      continue;
    }
    const seen = new Set<number>();
    for (const p of explicit) {
      if (seen.has(p)) {
        throw new Error(
          `Topic "${topic}" has multiple entries for partition ${p}; ` +
            `specify each (topic, partition) pair at most once.`,
        );
      }
      seen.add(p);
    }
    keepPartitions.set(topic, seen);
  }
  return keepPartitions;
}

/**
 * Validate an explicit `start: {offset}` against the partition's
 * `[low, high)` watermarks and return the seek target. Throws if the
 * partition has no offset metadata or the requested offset is out of
 * range.
 */
async function resolveExplicitOffsetSeek(
  topic: string,
  partition: number,
  offset: string,
  getWatermarks: WatermarkCache,
): Promise<PreflightPlan["seeks"][number]> {
  const offsets = await getWatermarks(topic);
  const partOffsets = offsets.find((o) => o.partition === partition);
  if (!partOffsets) {
    throw new Error(
      `Topic "${topic}" partition ${partition} returned no offset metadata.`,
    );
  }
  const low = BigInt(partOffsets.low);
  const high = BigInt(partOffsets.high);
  const target = BigInt(offset);
  if (target < low || target >= high) {
    throw new Error(
      `Topic "${topic}" partition ${partition} offset ${offset} is out of range ` +
        `[low=${partOffsets.low}, high=${partOffsets.high}). ` +
        `An empty partition has low === high; pick an offset already on the partition.`,
    );
  }
  return { topic, partition, offset };
}

/**
 * Resolve a `start: {tail: N}` to a single seek target on the requested
 * partition. Computes `target = max(low, high - N)` using `BigInt`
 * (Kafka offsets are int64; `N` may legitimately be large).
 *
 * Empty-partition contract (`low === high`): the seek target collapses
 * to `high` (`max(high, high - N) === high`), which parks the consumer
 * at `OFFSET_END`. No records flow, the orchestrator's `timeoutMs`
 * budget fires, and the call returns an empty success response — the
 * issue's "tail on empty partition returns zero, no error" path. The
 * `BigInt` subtraction stays well-defined for huge `N` because the
 * arithmetic compares signed values and `max` clamps back into the
 * `[low, high)` range before serializing.
 */
async function resolveTailSeek(
  topic: string,
  partition: number,
  count: number,
  getWatermarks: WatermarkCache,
): Promise<PreflightPlan["seeks"][number]> {
  const offsets = await getWatermarks(topic);
  const partOffsets = offsets.find((o) => o.partition === partition);
  if (!partOffsets) {
    throw new Error(
      `Topic "${topic}" partition ${partition} returned no offset metadata.`,
    );
  }
  const low = BigInt(partOffsets.low);
  const high = BigInt(partOffsets.high);
  const candidate = high - BigInt(count);
  const target = candidate < low ? low : candidate;
  return { topic, partition, offset: target.toString() };
}

/**
 * Resolve a `start: {timestamp}` to per-partition offsets via
 * `admin.fetchTopicOffsetsByTimestamp` AND filter out the binding's
 * silent high-watermark substitutions.
 *
 * `@confluentinc/kafka-javascript`'s `fetchTopicOffsetsByTimestamp`
 * silently substitutes the partition's high watermark when no message
 * exists at or after the requested timestamp (see the method's
 * docstring in node_modules/.../kafkajs/_admin.js). Seeking to a
 * position == high watermark parks the consumer at OFFSET_END and we'd
 * time out with zero messages with no signal as to why. The defense:
 * cross-check each resolved offset against the partition's actual
 * watermarks, skip silent partitions, and emit a diagnostic log so
 * operators can distinguish the three resolution modes (silent /
 * broker-low-fallback / real-index-hit).
 */
async function resolveTimestampSeeks(
  admin: KafkaJS.Admin,
  topic: string,
  restrictToPartition: number | undefined,
  timestampMs: number,
  getWatermarks: WatermarkCache,
): Promise<PreflightPlan["seeks"]> {
  const resolved = await admin.fetchTopicOffsetsByTimestamp(topic, timestampMs);
  const watermarks = await getWatermarks(topic);
  const watermarkByPartition = new Map<number, { low: string; high: string }>();
  for (const w of watermarks) {
    watermarkByPartition.set(w.partition, { low: w.low, high: w.high });
  }

  const candidates =
    restrictToPartition === undefined
      ? resolved
      : resolved.filter((r) => r.partition === restrictToPartition);

  const active: typeof candidates = [];
  const silent: number[] = [];
  for (const r of candidates) {
    const wm = watermarkByPartition.get(r.partition);
    // Diagnostic log so debugging timestamp-to-offset resolution
    // doesn't require adding instrumentation later. Lets a reader
    // distinguish three failure modes from one log inspection:
    //   - resolvedOffset == high → binding's silent substitution
    //     (already filtered below; the warn-level log fires too).
    //   - resolvedOffset == low → broker fell back to the earliest
    //     offset (e.g. requested timestamp is older than every
    //     indexed message, or tiered-storage index quirk).
    //   - resolvedOffset in (low, high) → real timestamp resolution.
    logger.info(
      {
        topic,
        partition: r.partition,
        resolvedOffset: r.offset,
        low: wm?.low,
        high: wm?.high,
        requestedMs: timestampMs,
        requestedIso: new Date(timestampMs).toISOString(),
      },
      `Timestamp → offset resolution for ${topic} partition ${r.partition}`,
    );
    if (wm !== undefined && BigInt(r.offset) >= BigInt(wm.high)) {
      silent.push(r.partition);
    } else {
      active.push(r);
    }
  }

  if (active.length === 0) {
    const scopePhrase =
      restrictToPartition === undefined
        ? "every partition"
        : `partition ${restrictToPartition}`;
    throw new Error(
      `Topic "${topic}" has no messages at or after timestamp ` +
        `${new Date(timestampMs).toISOString()} ` +
        `(${scopePhrase} has no record produced past that point). ` +
        `Try an earlier timestamp, or use \`start: "latest"\` to consume ` +
        `from the live position instead.`,
    );
  }
  if (silent.length > 0) {
    logger.warn(
      { topic, timestampMs, silentPartitions: silent },
      `Skipping seek for partitions of "${topic}" with no record at or after the requested timestamp; they will idle at OFFSET_END.`,
    );
  }

  return active.map((r) => ({
    topic,
    partition: r.partition,
    offset: r.offset,
  }));
}

/**
 * Resolve a `start: "earliest"` entry that lost the direction-derivation
 * race — i.e. another entry pushed the consumer-wide
 * `auto.offset.reset` to `"latest"`. Returns explicit low-watermark
 * seeks for every partition (or the single restricted partition) so
 * this topic replays its history instead of inheriting the
 * consumer-wide "latest" default.
 */
async function resolveEarliestMinoritySeeks(
  topic: string,
  restrictToPartition: number | undefined,
  getWatermarks: WatermarkCache,
): Promise<PreflightPlan["seeks"]> {
  const offsets = await getWatermarks(topic);
  const partitionsToSeek =
    restrictToPartition === undefined
      ? offsets
      : offsets.filter((o) => o.partition === restrictToPartition);
  return partitionsToSeek.map((p) => ({
    topic,
    partition: p.partition,
    offset: p.low,
  }));
}

async function buildPreflightPlan(
  admin: KafkaJS.Admin,
  targets: NormalizedTopicTarget[],
  consumerOffsetReset: "earliest" | "latest",
): Promise<PreflightPlan> {
  guardScopedStartRequiresPartition(targets);
  const byTopic = new Map<string, NormalizedTopicTarget[]>();
  for (const t of targets) {
    const list = byTopic.get(t.name);
    if (list) list.push(t);
    else byTopic.set(t.name, [t]);
  }
  const topicNames = [...byTopic.keys()];
  const numPartitionsByTopic = await fetchPartitionCounts(admin, topicNames);
  validateRequestedPartitions(targets, numPartitionsByTopic);
  const keepPartitions = validateAndBuildKeepPartitions(byTopic);

  const getWatermarks = createWatermarkCache(admin);
  const seeks: PreflightPlan["seeks"] = [];
  for (const t of targets) {
    if (t.start.kind === "offset" && t.partition !== undefined) {
      seeks.push(
        await resolveExplicitOffsetSeek(
          t.name,
          t.partition,
          t.start.value,
          getWatermarks,
        ),
      );
    } else if (t.start.kind === "timestamp") {
      seeks.push(
        ...(await resolveTimestampSeeks(
          admin,
          t.name,
          t.partition,
          t.start.ms,
          getWatermarks,
        )),
      );
    } else if (t.start.kind === "tail" && t.partition !== undefined) {
      seeks.push(
        await resolveTailSeek(
          t.name,
          t.partition,
          t.start.count,
          getWatermarks,
        ),
      );
    } else if (
      t.start.kind === "earliest" &&
      consumerOffsetReset === "latest"
    ) {
      seeks.push(
        ...(await resolveEarliestMinoritySeeks(
          t.name,
          t.partition,
          getWatermarks,
        )),
      );
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
 * Exported so the three branches (immediate-return, polled-populate,
 * polled-timeout) can be exercised directly under fake timers.
 */
export async function waitForAssignment(
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
 * isn't in the keep-set. Seeks were stashed before `consumer.run()` (see
 * the inline comment in the orchestrator) so the per-partition seek
 * targets are already baked into the assignment by the time this runs.
 */
async function applyPauseAfterAssignment(
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
}

/**
 * Wrap a promise so its successful resolution is ignored (never settles
 * downstream) while its rejection still propagates. Used in the
 * orchestrator's `Promise.race` to let "engine still running" branches
 * (`consumer.run`, `applyPostAssignmentHook`) participate only on
 * failure — successful completion of those promises shouldn't end the
 * consume loop, but their errors must surface as the race's rejection.
 */
function rejectOnly<T>(p: Promise<T>): Promise<never> {
  return p.then(() => new Promise<never>(() => {}));
}

/**
 * Drive the post-`consumer.run()` pause step: poll for an assignment up
 * to `deadlineMs`, then pause partitions outside the keep-set. Signals
 * completion via callbacks rather than its return value because the
 * orchestrator's `Promise.race` only cares about success (`onApplied`)
 * vs. assignment-deadline-elapsed (`onAssignmentTimedOut`); internal
 * pause failures propagate as a rejection so the race can surface them
 * via `rejectOnly`.
 */
export async function applyPostAssignmentHook(opts: {
  consumer: KafkaJS.Consumer;
  plan: PreflightPlan;
  deadlineMs: number;
  onApplied: () => void;
  onAssignmentTimedOut: () => void;
}): Promise<void> {
  const assignment = await waitForAssignment(opts.consumer, opts.deadlineMs);
  if (!assignment) {
    opts.onAssignmentTimedOut();
    return;
  }
  await applyPauseAfterAssignment(opts.consumer, opts.plan, assignment);
  opts.onApplied();
}

/**
 * Build the `eachMessage` callback `consumer.run` invokes per record.
 * Pulled out of the orchestrator so the synchronous gates and the
 * "did we hit `maxMessages`?" signal are individually testable.
 *
 * The synchronous boolean/predicate getters (`isAccepting`,
 * `isPreflightApplied`, `shouldKeepDuringPrePause`) intentionally stay
 * synchronous — `await`ing a Deferred in their place would change
 * behavior, because pre-pause deliveries from librdkafka's fetch buffer
 * must be filtered on arrival rather than queued through.
 *
 * Pre-pause gate semantics: before the post-assignment pause step has
 * run, drop a delivery **only** when its `(topic, partition)` is one
 * we'd pause anyway (i.e. outside the topic's keep-set). Keep-set
 * deliveries arriving during the brief window between assignment-landing
 * and pause-being-applied are real records the caller asked for; the
 * pre-run-stashed seeks have already positioned the consumer, so
 * librdkafka can hand them to `eachMessage` immediately. Dropping them
 * would be silent data loss. After `preflightApplied` flips, the gate
 * doesn't fire (pause has already kept the unwanted partitions silent).
 */
export function createEachMessageHandler(opts: {
  state: {
    consumedMessages: ProcessedMessage[];
    isAccepting: () => boolean;
    isPreflightApplied: () => boolean;
    /**
     * Returns `true` if this `(topic, partition)` is in the topic's
     * keep-set (or the topic has no partition restriction at all). Used
     * by the pre-pause gate to let legitimate caller-requested records
     * through immediately while still dropping the about-to-be-paused
     * partitions that librdkafka may deliver in the assignment-to-pause
     * window.
     */
    shouldKeepDuringPrePause: (topic: string, partition: number) => boolean;
  };
  maxMessages: number;
  onMaxReached: () => void;
  processMessage: (
    topic: string,
    partition: number,
    message: KafkaMessage,
  ) => Promise<ProcessedMessage>;
}): (payload: {
  topic: string;
  partition: number;
  message: KafkaMessage;
}) => Promise<void> {
  return async ({ topic, partition, message }) => {
    if (!opts.state.isAccepting()) return;
    if (
      !opts.state.isPreflightApplied() &&
      !opts.state.shouldKeepDuringPrePause(topic, partition)
    ) {
      return;
    }
    const processed = await opts.processMessage(topic, partition, message);
    opts.state.consumedMessages.push(processed);
    if (opts.state.consumedMessages.length >= opts.maxMessages) {
      opts.onMaxReached();
    }
  };
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
   * @param valueOptions - Options for value-side deserialization
   * @param keyOptions - Options for key-side deserialization
   * @returns A processed message with deserialized key and value
   */
  async processMessage(
    topic: string,
    partition: number,
    message: KafkaMessage,
    registry: SchemaRegistryClient | undefined,
    valueOptions: ValueOptions,
    keyOptions: KeyOptions,
  ): Promise<ProcessedMessage> {
    let processedKey: unknown = message.key?.toString();
    let processedValue: unknown = message.value?.toString();

    const deserializeWithOptions = async (
      buffer: Buffer | undefined,
      options: ValueOptions | KeyOptions,
      serdeType: SerdeType,
    ): Promise<unknown> => {
      if (options.disableSchemaRegistry || !registry) {
        return buffer?.toString();
      }
      const subject =
        options.subject ||
        `${topic}-${serdeType === SerdeType.KEY ? "key" : "value"}`;
      const schema = await schemaRegistryHelper.getLatestSchemaIfExists(
        registry,
        subject,
      );
      if (!schema || !schema.schemaType) {
        return buffer?.toString();
      }
      try {
        return await schemaRegistryHelper.deserializeMessage(
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
    if (message.key) {
      processedKey = await deserializeWithOptions(
        message.key as Buffer,
        keyOptions,
        SerdeType.KEY,
      );
    }

    return {
      key: processedKey,
      value: processedValue,
      timestamp: formatMessageTimestamp(message.timestamp),
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
   * Consume messages from one or more Kafka topics, honoring per-topic
   * `partition` and `start` controls. Resolves when one of four exit
   * conditions wins a `Promise.race`: `maxMessages` records have been
   * collected, the `timeoutMs` budget elapses, `consumer.run()` rejects,
   * or the post-assignment hook rejects. On the timeout path the
   * partial set collected so far is returned (success-shaped response,
   * not an error).
   *
   * @param runtime - The {@link ServerRuntime} (config + active client
   *   manager + OAuth holder). Supplied by the MCP server dispatcher;
   *   the handler resolves cluster/env/registry clients off of it.
   * @param toolArguments - Parsed args matching `consumeKafkaMessagesArgs`.
   *   The handler re-parses internally to apply defaults at the
   *   boundary.
   * @returns A {@link CallToolResult}. Success path emits a text block
   *   summarizing the consumed messages; failures (build/preflight/run
   *   errors) surface via `createResponse(text, true)` with the
   *   formatted Kafka error.
   */
  async handle(
    runtime: ServerRuntime,
    toolArguments: z.infer<typeof consumeKafkaMessagesArgs>,
  ): Promise<CallToolResult> {
    const parsed = consumeKafkaMessagesArgs.parse(toolArguments);
    const { maxMessages, timeoutMs, valueFormat, keyFormat } = parsed;

    const { connId, conn, clientManager } = this.resolveSoleConnection(runtime);
    const resolved = resolveKafkaClusterArgs(parsed, runtime, connId);

    // Auto-decode when SR is reachable on this connection (OAuth always; direct
    // requires a `schema_registry` block — single source of truth lives in the
    // `hasSchemaRegistryOrOAuth` predicate) and the caller hasn't opted out on
    // BOTH sides. Either side wanting decode triggers the SR fetch.
    const userDisabled =
      valueFormat.disableSchemaRegistry && keyFormat.disableSchemaRegistry;
    const srReachable = hasSchemaRegistryOrOAuth(conn).enabled;

    let registry: SchemaRegistryClient | undefined;
    if (!userDisabled && srReachable) {
      try {
        registry = await clientManager.getSchemaRegistrySdkClient(
          resolved.envId,
        );
      } catch (error: unknown) {
        // Graceful fallback: user didn't explicitly opt in, so an SR-transport
        // failure shouldn't fail an otherwise-satisfiable consume. Per-message
        // decode errors already fall back to raw inside processMessage.
        logger.warn(
          { error, connId },
          "Schema Registry client unavailable; consuming as raw bytes.",
        );
      }
    }

    const targets = normalizeTopicTargets(parsed);
    const offsetReset = deriveConsumerOffsetReset(targets);
    const needsPreflight = planNeedsPreflight(targets, offsetReset);

    let plan: PreflightPlan;
    if (needsPreflight) {
      // `admin` is acquired INSIDE the try so a failed
      // getKafkaAdminClient() (auth/network) becomes a tool-error
      // response rather than propagating up unhandled. The finally
      // guards against running disposeIfOAuth on an undefined admin
      // (which would happen if the acquisition itself threw).
      let admin: KafkaJS.Admin | undefined;
      try {
        admin = await clientManager.getKafkaAdminClient(
          resolved.clusterId,
          resolved.envId,
        );
        plan = await buildPreflightPlan(admin, targets, offsetReset);
      } catch (error: unknown) {
        return this.createResponse(
          `Failed to consume messages: ${formatKafkaError(error)}`,
          true,
        );
      } finally {
        if (admin !== undefined) {
          await disposeIfOAuth(runtime, connId, admin);
        }
      }
    } else {
      plan = {
        topicNames: [...new Set(targets.map((t) => t.name))],
        keepPartitions: new Map(),
        seeks: [],
      };
    }

    const consumedMessages: ProcessedMessage[] = [];
    // `accepting` is the synchronous gate that suppresses further
    // processing once any terminal condition fires. `preflightApplied`
    // is the synchronous gate that drops pre-pause fetch-buffer
    // deliveries. Both stay booleans because eachMessage needs to check
    // them on arrival — a `Promise` would require `await`, which would
    // queue rather than drop the message.
    let accepting = true;
    let preflightApplied = !needsPreflight;
    let consumer: KafkaJS.Consumer | undefined;

    try {
      consumer = await clientManager.buildKafkaConsumer({
        clusterId: resolved.clusterId,
        envId: resolved.envId,
        // Per-invocation unique group id: each consume call becomes
        // the sole member of its own Kafka consumer group, so two
        // concurrent calls can't race for the same partition
        // assignment via rebalance. (How the value reaches `group.id`
        // depends on the manager: `DirectClientManager` appends it as
        // a suffix to its base `mcp-confluent` group; `OAuthClientManager`
        // uses it as the literal group id. Both yield a unique-per-call
        // group, which is what the no-contention contract requires.)
        groupId: nodeCrypto.randomUUID(),
        offsetReset,
      });
      await consumer.connect();
      await consumer.subscribe({ topics: plan.topicNames });

      // Stash per-partition seeks on the consumer BEFORE `consumer.run()`
      // is invoked. The kafkajs-compat library queues these as "pending
      // seeks" via its `#addPendingOperation` → `#seekInternal` path; when
      // the first rebalance fires inside `run()`, the assignment handler
      // calls `#assignAsPerSeekedOffsets` and modifies the assignment to
      // include the seeked offsets BEFORE calling `assignmentFn`, so the
      // partition is assigned at the seek target atomically.
      //
      // This avoids the `ERR__STATE` race that the post-assignment seek
      // path trips: even after `consumer.assignment()` returns the
      // partition, the native librdkafka client can briefly reject seeks
      // because its internal state hasn't fully transitioned from
      // "rebalancing" to "ready." The pre-run path bypasses native seek
      // calls entirely.
      for (const s of plan.seeks) {
        consumer.seek({
          topic: s.topic,
          partition: s.partition,
          offset: s.offset,
        });
      }

      // Named exit conditions. Each Deferred resolves only its own
      // promise — the prior shared `timeoutReached` boolean was written
      // by three sites with overlapping semantics; this splits them into
      // independent signals the race observes.
      const maxReached = Promise.withResolvers<void>();
      const timedOut = Promise.withResolvers<void>();
      const consumerActive = consumer;

      const eachMessage = createEachMessageHandler({
        state: {
          consumedMessages,
          isAccepting: () => accepting,
          isPreflightApplied: () => preflightApplied,
          // Pre-pause gate predicate: a (topic, partition) is "keep" if
          // the topic has no partition restriction (keepPartitions omits
          // it) or the partition is in the topic's keep-set. The
          // orchestrator's `plan.keepPartitions` is built so absence of
          // an entry means "no restriction"; we honor that contract here.
          shouldKeepDuringPrePause: (topic, partition) => {
            const keepSet = plan.keepPartitions.get(topic);
            return keepSet === undefined || keepSet.has(partition);
          },
        },
        maxMessages,
        onMaxReached: () => {
          accepting = false;
          maxReached.resolve();
        },
        processMessage: (topic, partition, message) =>
          this.processMessage(
            topic,
            partition,
            message,
            registry,
            valueFormat,
            keyFormat,
          ),
      });

      const timer = setTimeout(() => {
        accepting = false;
        timedOut.resolve();
      }, timeoutMs);

      const preflightHook = needsPreflight
        ? applyPostAssignmentHook({
            consumer: consumerActive,
            plan,
            deadlineMs: Date.now() + timeoutMs,
            onApplied: () => {
              preflightApplied = true;
            },
            onAssignmentTimedOut: () => {
              accepting = false;
              timedOut.resolve();
            },
          })
        : Promise.resolve();

      const runPromise = consumerActive.run({ eachMessage });

      try {
        await Promise.race([
          maxReached.promise,
          timedOut.promise,
          // Success of either branch means "engine still running" — only
          // their rejection is a terminal condition for the race.
          rejectOnly(runPromise),
          rejectOnly(preflightHook),
        ]);
      } finally {
        clearTimeout(timer);
        accepting = false;
      }

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
        "Consume messages from Kafka topics. Optionally restrict to a partition, start from an offset, timestamp, earliest, latest, or tailmost pre-existing messages." +
        " Auto-deserializes Schema Registry messages (AVRO/JSON/PROTOBUF) when SR is configured on the connection; pass `valueFormat: {disableSchemaRegistry: true}` (or `keyFormat`) to skip decoding per side.",
      inputSchema: consumeKafkaMessagesArgs.shape,
      annotations: READ_ONLY,
    };
  }

  readonly category = ToolCategory.Kafka;
  readonly predicate = kafkaBootstrapOrOAuth;
}
