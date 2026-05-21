import {
  createWatermarkCache,
  fetchPartitionWatermarks,
  narrowMessageCount,
} from "@src/confluent/tools/handlers/kafka/partition-watermarks.js";
import { logger } from "@src/logger.js";
import { getMockedAdmin } from "@tests/stubs/index.js";
import { describe, expect, it, vi } from "vitest";

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

describe("partition-watermarks.ts", () => {
  describe("narrowMessageCount()", () => {
    it("should pass small non-negative BigInt diffs through as a Number", () => {
      expect(narrowMessageCount(0n, {})).toBe(0);
      expect(narrowMessageCount(1n, {})).toBe(1);
      expect(narrowMessageCount(1_000_000n, {})).toBe(1_000_000);
    });

    it("should pass small negative BigInt diffs through unchanged", () => {
      // The lag tool surfaces a rebalance-race condition (committed >
      // high watermark) as a small negative lag rather than clamping to
      // zero — clamping would hide a real, if rare, state. The asymmetric
      // saturation guard intentionally does not interfere with negative
      // diffs of realistic magnitude.
      expect(narrowMessageCount(-3n, {})).toBe(-3);
      expect(narrowMessageCount(-100n, {})).toBe(-100);
    });

    it("should narrow exactly Number.MAX_SAFE_INTEGER without triggering the Wacky branch", () => {
      // The saturation check is strict `> maxSafe`, not `>= maxSafe`, so a
      // diff that lands exactly on the boundary returns Number(diff)
      // through the happy path. Asserting `warn` was never called is what
      // distinguishes this branch from the saturate branch — the return
      // value is identical at the boundary.
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

      expect(narrowMessageCount(MAX_SAFE_BIGINT, { topic: "edge" })).toBe(
        Number.MAX_SAFE_INTEGER,
      );

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("should saturate to Number.MAX_SAFE_INTEGER and emit a Wacky log when the diff exceeds the safe-integer boundary", () => {
      // The saturation arm is a defensive sentinel; spy on `logger.warn`
      // only to silence the noise and to distinguish this branch from the
      // boundary case in the previous test. Log content is not asserted
      // (per CLAUDE.md: don't pin logging side effects), only that the
      // branch was taken.
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

      expect(
        narrowMessageCount(MAX_SAFE_BIGINT + 1n, { groupId: "overflow" }),
      ).toBe(Number.MAX_SAFE_INTEGER);

      expect(warnSpy).toHaveBeenCalledOnce();
    });
  });

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
