import type { ITopicMetadata } from "@confluentinc/kafka-javascript/types/kafkajs.js";
import { normalizeFetchTopicMetadataResponse } from "@src/confluent/tools/handlers/kafka/topic-metadata.js";
import { describe, expect, it } from "vitest";

type FetchTopicMetadataResponse = Parameters<
  typeof normalizeFetchTopicMetadataResponse
>[0];

describe("topic-metadata.ts", () => {
  describe("normalizeFetchTopicMetadataResponse()", () => {
    const sample: ITopicMetadata[] = [
      { name: "orders", partitions: [] },
      { name: "shipments", partitions: [] },
    ];

    it("should return the bare array unchanged when the runtime resolves with an Array<ITopicMetadata> (the actual kafkajs-compat behavior — see confluentinc/confluent-kafka-javascript#367)", () => {
      const raw = sample as unknown as FetchTopicMetadataResponse;

      expect(normalizeFetchTopicMetadataResponse(raw)).toBe(sample);
    });

    it("should unwrap the `{topics: [...]}` shape when the runtime resolves with the wrapper object (the .d.ts-declared shape, retained in case the library ever reconciles)", () => {
      expect(normalizeFetchTopicMetadataResponse({ topics: sample })).toBe(
        sample,
      );
    });

    it("should return an empty array when given an empty `{topics: []}` wrapper", () => {
      expect(normalizeFetchTopicMetadataResponse({ topics: [] })).toEqual([]);
    });

    it("should return an empty array when given a bare empty array", () => {
      const raw = [] as unknown as FetchTopicMetadataResponse;

      expect(normalizeFetchTopicMetadataResponse(raw)).toEqual([]);
    });
  });
});
