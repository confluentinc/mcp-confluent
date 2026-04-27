import { KafkaJS } from "@confluentinc/kafka-javascript";
import { type Mock, vi } from "vitest";

/** {@link KafkaJS.Admin} with all methods replaced by {@link Mock mocks}. */
export type MockedAdmin = {
  [K in keyof KafkaJS.Admin]: Mock;
};

/**
 * Creates a {@link KafkaJS.Admin} mock with all methods replaced by
 * {@link Mock mocks}. Each method resolves with a sensible empty default.
 */
export function createMockAdmin(): MockedAdmin {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    createTopics: vi.fn().mockResolvedValue(true),
    deleteTopics: vi.fn().mockResolvedValue(undefined),
    listTopics: vi.fn().mockResolvedValue([]),
    listGroups: vi.fn().mockResolvedValue({ groups: [], errors: [] }),
    describeGroups: vi.fn().mockResolvedValue({ groups: [] }),
    deleteGroups: vi.fn().mockResolvedValue([]),
    fetchOffsets: vi.fn().mockResolvedValue([]),
    deleteTopicRecords: vi.fn().mockResolvedValue([]),
    fetchTopicMetadata: vi.fn().mockResolvedValue({ topics: [] }),
    fetchTopicOffsets: vi.fn().mockResolvedValue([]),
    fetchTopicOffsetsByTimestamp: vi.fn().mockResolvedValue([]),
  };
}
