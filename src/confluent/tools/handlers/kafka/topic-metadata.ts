import { KafkaJS } from "@confluentinc/kafka-javascript";
import type { ITopicMetadata } from "@confluentinc/kafka-javascript/types/kafkajs.js";

/**
 * Normalize the runtime shape of `admin.fetchTopicMetadata`'s response to
 * a bare `ITopicMetadata[]` regardless of which surface the
 * `@confluentinc/kafka-javascript` layer happens to return today. The
 * `.d.ts` declares the call as `Promise<{ topics: Array<ITopicMetadata> }>`
 * but the runtime resolves with the bare array — long-standing mismatch
 * tracked at confluentinc/confluent-kafka-javascript#367. Handle either
 * shape so a future library fix doesn't require code change at the call
 * sites.
 */
export function normalizeFetchTopicMetadataResponse(
  raw: Awaited<ReturnType<KafkaJS.Admin["fetchTopicMetadata"]>>,
): ITopicMetadata[] {
  return Array.isArray(raw) ? (raw as unknown as ITopicMetadata[]) : raw.topics;
}
