import { KafkaJS } from "@confluentinc/kafka-javascript";

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
 * Thin wrapper around `admin.fetchTopicOffsets(topic)` that normalizes
 * the response to {@link PartitionWatermark}. Shared seam between the
 * consume handler's per-call watermark cache (see
 * {@link createWatermarkCache}) and #480's standalone
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
