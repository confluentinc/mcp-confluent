import {
  createWatermarkCache,
  fetchPartitionWatermarks,
} from "@src/confluent/tools/handlers/kafka/partition-watermarks.js";
import { getMockedAdmin } from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

describe("partition-watermarks.ts", () => {
  describe("fetchPartitionWatermarks()", () => {
    it("should narrow admin.fetchTopicOffsets's response to {partition, low, high}, dropping the unused committed `offset` field", async () => {
      // The committed `offset` field on the upstream response isn't the
      // same as `high` (it's the next-to-be-committed group offset, not
      // the partition end-of-log) and neither this module's callers nor
      // #480's `get-partition-offsets` handler read it. Narrowing here
      // keeps the seam small and prevents accidental dependence on a
      // field whose semantics differ from its name.
      const admin = getMockedAdmin();
      admin.fetchTopicOffsets.mockResolvedValue([
        { partition: 0, low: "0", high: "100", offset: "100" },
        { partition: 1, low: "50", high: "200", offset: "200" },
      ]);

      const result = await fetchPartitionWatermarks(admin, "topic-x");

      expect(result).toEqual([
        { partition: 0, low: "0", high: "100" },
        { partition: 1, low: "50", high: "200" },
      ]);
      expect(admin.fetchTopicOffsets).toHaveBeenCalledWith("topic-x");
    });
  });

  describe("createWatermarkCache()", () => {
    it("should hit admin.fetchTopicOffsets only once per topic across repeated calls", async () => {
      // The consume handler reads watermarks from three independent
      // resolution paths within a single tool call; memoization here is
      // load-bearing for keeping the admin round-trip count linear in
      // the number of distinct topics rather than in the number of
      // resolution sites.
      const admin = getMockedAdmin();
      admin.fetchTopicOffsets.mockResolvedValue([
        { partition: 0, low: "0", high: "100", offset: "100" },
      ]);

      const cache = createWatermarkCache(admin);
      const first = await cache("orders");
      const second = await cache("orders");

      expect(first).toEqual([{ partition: 0, low: "0", high: "100" }]);
      // Reference equality — the cached array is the same memoized
      // instance, not just structurally identical to a fresh fetch.
      expect(second).toBe(first);
      expect(admin.fetchTopicOffsets).toHaveBeenCalledOnce();
    });

    it("should fetch independently for distinct topics", async () => {
      const admin = getMockedAdmin();
      admin.fetchTopicOffsets.mockResolvedValue([
        { partition: 0, low: "0", high: "5", offset: "5" },
      ]);

      const cache = createWatermarkCache(admin);
      await cache("orders");
      await cache("shipments");

      expect(admin.fetchTopicOffsets).toHaveBeenCalledTimes(2);
      expect(admin.fetchTopicOffsets).toHaveBeenNthCalledWith(1, "orders");
      expect(admin.fetchTopicOffsets).toHaveBeenNthCalledWith(2, "shipments");
    });
  });
});
