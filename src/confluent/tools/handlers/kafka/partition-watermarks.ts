import { KafkaJS } from "@confluentinc/kafka-javascript";
import { logger } from "@src/logger.js";

/**
 * Per-partition low/high watermark pair, normalized to the fields the
 * consume handler and the standalone `get-partition-offsets` tool both
 * read. The upstream `admin.fetchTopicOffsets` response also carries a
 * committed `offset` field (the next-to-be-committed group offset, not
 * the partition end-of-log), which neither caller uses; this type drops
 * it so a shared response shape governs both surfaces.
 */
export interface PartitionWatermark {
  partition: number;
  low: string;
  high: string;
}

/**
 * Narrow a {@link BigInt} difference to a JS `Number`, saturating at
 * {@link Number.MAX_SAFE_INTEGER} or {@link Number.MIN_SAFE_INTEGER}
 * when the result would lose precision. The narrow path is the only one
 * expected to fire in practice (even a million-msg/sec partition with
 * infinite retention takes ~285 years to exceed 2^53 - 1); the
 * saturation arms are defensive sentinels — hence the `Wacky --` log
 * signaling "this branch firing means something genuinely surprising
 * happened". Symmetric guards on both ends of the safe range so a `diff`
 * produced by an unexpected caller pattern (e.g. a far-ahead committed
 * offset, or a cross-partition sum of many negative lags) can't silently
 * lose precision.
 *
 * `context` is forwarded verbatim into the log payload so each caller
 * can name the dimensions it knows about (`{topicName, partition}` for
 * the standalone watermark tool, `{groupId, topic, partition}` for the
 * consumer-group lag tool) without this helper hard-coding either.
 */
export function narrowMessageCount(
  diff: bigint,
  context: Record<string, unknown>,
): number {
  const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
  const minSafe = BigInt(Number.MIN_SAFE_INTEGER);
  if (diff > maxSafe) {
    logger.warn(
      context,
      "Wacky -- messageCount BigInt subtraction exceeds Number.MAX_SAFE_INTEGER; saturating to MAX_SAFE_INTEGER",
    );
    return Number.MAX_SAFE_INTEGER;
  }
  if (diff < minSafe) {
    logger.warn(
      context,
      "Wacky -- messageCount BigInt subtraction below Number.MIN_SAFE_INTEGER; saturating to MIN_SAFE_INTEGER",
    );
    return Number.MIN_SAFE_INTEGER;
  }
  return Number(diff);
}

/**
 * Thin wrapper around `admin.fetchTopicOffsets(topic)` that normalizes
 * the response to {@link PartitionWatermark}. Shared seam between the
 * consume handler's per-call watermark cache (see
 * {@link createWatermarkCache}) and standalone
 * `get-partition-offsets` tool — single source of truth for the
 * response shape both surfaces see.
 */
export async function fetchPartitionWatermarks(
  admin: KafkaJS.Admin,
  topic: string,
): Promise<PartitionWatermark[]> {
  const raw = await admin.fetchTopicOffsets(topic);
  return raw.map(({ partition, low, high }) => ({ partition, low, high }));
}

/**
 * Lazy per-topic memoized watermark fetcher. The consume handler hits
 * `admin.fetchTopicOffsets` from four independent resolution paths
 * within a single tool call (explicit-offset bounds check, timestamp's
 * silent-substitution cross-check, earliest-minority low-watermark
 * seek, and tail-mode seek resolution); the cache keeps the admin
 * round-trip count linear in the number of distinct topics rather than
 * the number of resolution sites.
 */
export type WatermarkCache = (topic: string) => Promise<PartitionWatermark[]>;

export function createWatermarkCache(admin: KafkaJS.Admin): WatermarkCache {
  const cache = new Map<string, PartitionWatermark[]>();
  return async (topic) => {
    let wm = cache.get(topic);
    if (!wm) {
      wm = await fetchPartitionWatermarks(admin, topic);
      cache.set(topic, wm);
    }
    return wm;
  };
}
