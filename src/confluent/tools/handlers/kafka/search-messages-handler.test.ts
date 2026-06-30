import type {
  EachBatchPayload,
  KafkaMessage,
} from "@confluentinc/kafka-javascript/types/kafkajs.js";
import { READ_ONLY } from "@src/confluent/tools/base-tools.js";
import type { ProcessedMessage } from "@src/confluent/tools/handlers/kafka/message-processing.js";
import {
  buildMatcher,
  messageMatches,
  searchMessagesArgs,
  SearchMessagesHandler,
} from "@src/confluent/tools/handlers/kafka/search-messages-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  DEFAULT_CONNECTION_ID,
  runtimeWith,
} from "@tests/factories/runtime.js";
import {
  getMockedAdmin,
  getMockedClientManager,
  getMockedConsumer,
} from "@tests/stubs/index.js";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * Build a synthetic `KafkaMessage` for tests. The cast hides the fields the
 * handler doesn't read so each test focuses on key/value/headers.
 */
function fakeMessage(
  overrides: {
    key?: Buffer | null;
    value?: Buffer | null;
    headers?: KafkaMessage["headers"];
  } = {},
): KafkaMessage {
  return {
    key: "key" in overrides ? overrides.key : null,
    value: "value" in overrides ? overrides.value : Buffer.from("v"),
    timestamp: "1747234567000",
    offset: "42",
    headers: overrides.headers,
  } as unknown as KafkaMessage;
}

function makeProcessed(over: Partial<ProcessedMessage> = {}): ProcessedMessage {
  return {
    key: undefined,
    value: undefined,
    timestamp: "2025-05-14T17:00:00.000Z",
    offset: "0",
    topic: "t",
    partition: 0,
    ...over,
  };
}

describe("search-messages-handler.ts", () => {
  describe("searchMessagesArgs (schema defaults & validation)", () => {
    it("should apply documented defaults when only the required fields are given", () => {
      const parsed = searchMessagesArgs.parse({
        topicNames: ["orders"],
        query: "cust-42",
      });
      expect(parsed.queryMode).toBe("substring");
      expect(parsed.searchIn).toEqual(["value"]);
      expect(parsed.maxMatches).toBe(10);
      expect(parsed.maxScanned).toBe(1000);
      expect(parsed.timeoutMs).toBe(10000);
      expect(parsed.partitionConcurrency).toBe(4);
    });

    it("should reject a partitionConcurrency above the cap", () => {
      const result = searchMessagesArgs.safeParse({
        topicNames: ["orders"],
        query: "x",
        partitionConcurrency: 33,
      });
      expect(result.success).toBe(false);
    });

    it("should reject an empty topicNames array", () => {
      const result = searchMessagesArgs.safeParse({
        topicNames: [],
        query: "x",
      });
      expect(result.success).toBe(false);
    });

    it("should reject a missing query", () => {
      const result = searchMessagesArgs.safeParse({
        topicNames: ["orders"],
      });
      expect(result.success).toBe(false);
    });

    it("should reject an unknown queryMode", () => {
      const result = searchMessagesArgs.safeParse({
        topicNames: ["orders"],
        query: "x",
        queryMode: "fuzzy",
      });
      expect(result.success).toBe(false);
    });

    it("should reject an unknown searchIn member", () => {
      const result = searchMessagesArgs.safeParse({
        topicNames: ["orders"],
        query: "x",
        searchIn: ["payload"],
      });
      expect(result.success).toBe(false);
    });
  });

  describe("buildMatcher()", () => {
    it("should match a substring case-insensitively by default", () => {
      const matcher = buildMatcher("Denied", "substring");
      expect(matcher("permission DENIED here")).toBe(true);
      expect(matcher("granted")).toBe(false);
    });

    it("should compile a bare regex pattern in regex mode", () => {
      const matcher = buildMatcher("checkout.*failed", "regex");
      expect(matcher("checkout step failed")).toBe(true);
      expect(matcher("checkout succeeded")).toBe(false);
    });

    it("should honor flags in regex-literal syntax (/pattern/flags)", () => {
      const matcher = buildMatcher("/checkout.*failed/i", "regex");
      // The `i` flag makes the uppercase input match where a bare,
      // flagless pattern would not.
      expect(matcher("CHECKOUT STEP FAILED")).toBe(true);
    });

    it("should treat a flagless bare pattern as case-sensitive in regex mode", () => {
      const matcher = buildMatcher("checkout.*failed", "regex");
      expect(matcher("CHECKOUT STEP FAILED")).toBe(false);
    });

    it("should keep a trailing-slash-free pattern as a literal pattern body", () => {
      // No regex-literal wrapper, so `/` is part of the pattern.
      const matcher = buildMatcher("a/b", "regex");
      expect(matcher("x a/b y")).toBe(true);
    });

    it("should throw on an invalid bare regex pattern", () => {
      expect(() => buildMatcher("(", "regex")).toThrow();
    });

    it("should throw on an invalid flag in regex-literal syntax", () => {
      expect(() => buildMatcher("/abc/q", "regex")).toThrow();
    });
  });

  describe("messageMatches()", () => {
    const substring = buildMatcher("needle", "substring");

    it("should match against the value by default-search part", () => {
      const processed = makeProcessed({ value: "a needle in a haystack" });
      expect(messageMatches(processed, substring, ["value"])).toBe(true);
    });

    it("should not match the value when searching only the key", () => {
      const processed = makeProcessed({ key: "k", value: "needle" });
      expect(messageMatches(processed, substring, ["key"])).toBe(false);
    });

    it("should JSON-stringify a decoded object value before matching", () => {
      const processed = makeProcessed({ value: { note: "needle found" } });
      expect(messageMatches(processed, substring, ["value"])).toBe(true);
    });

    it("should match against both header names and string-coerced header values", () => {
      const byName = makeProcessed({ headers: { needle: "v" } });
      const byValue = makeProcessed({ headers: { h: ["needle", "other"] } });
      expect(messageMatches(byName, substring, ["headers"])).toBe(true);
      expect(messageMatches(byValue, substring, ["headers"])).toBe(true);
    });

    it("should treat an undefined value (tombstone) as no searchable text", () => {
      const processed = makeProcessed({ value: undefined });
      expect(messageMatches(processed, substring, ["value"])).toBe(false);
    });

    it("should not throw on a value JSON.stringify can't serialize (BigInt) and fall back to String()", () => {
      // A decoded long can surface as a BigInt; JSON.stringify throws on it.
      // The guard must coerce via String() instead of rejecting eachMessage.
      const bigintMatcher = buildMatcher("42", "substring");
      const processed = makeProcessed({ value: 42n });
      expect(() =>
        messageMatches(processed, bigintMatcher, ["value"]),
      ).not.toThrow();
      expect(messageMatches(processed, bigintMatcher, ["value"])).toBe(true);
    });
  });

  describe("SearchMessagesHandler", () => {
    const handler = new SearchMessagesHandler();

    describe("getToolConfig()", () => {
      const config = handler.getToolConfig();

      it("should advertise the search-messages tool name", () => {
        expect(config.name).toBe(ToolName.SEARCH_MESSAGES);
      });

      it("should be a read-only tool", () => {
        expect(config.annotations).toBe(READ_ONLY);
      });

      it("should expose the searchMessagesArgs shape as its input schema", () => {
        expect(config.inputSchema).toBe(searchMessagesArgs.shape);
      });
    });

    describe("handle()", () => {
      let clientManager: ReturnType<typeof getMockedClientManager>;
      let consumer: ReturnType<typeof getMockedConsumer>;
      let admin: ReturnType<typeof getMockedAdmin>;

      beforeEach(async () => {
        clientManager = getMockedClientManager();
        consumer = await clientManager.getConsumer();
        consumer.connect.mockResolvedValue(undefined);
        consumer.subscribe.mockResolvedValue(undefined);
        consumer.disconnect.mockResolvedValue(undefined);
        admin = await clientManager.getAdminClient();
        // Default watermarks: one partition with an end-of-log far beyond any
        // offset the tests deliver, so the end-of-log early-exit never fires
        // and these cases exit purely via maxMatches/maxScanned/timeout (the
        // behavior they assert). The dedicated end-of-log tests below override
        // this with reachable watermarks.
        admin.fetchTopicOffsets.mockResolvedValue([
          { partition: 0, low: "0", high: "1000000", offset: "0" },
        ] as unknown as Awaited<ReturnType<typeof admin.fetchTopicOffsets>>);
      });

      /**
       * Capture the handler's `eachBatch` callback so the test can drive
       * deliveries deterministically. `consumer.run` returns a
       * never-settling promise so the orchestrator's race only finishes via
       * the bounded (maxMatches/maxScanned), end-of-log, or timeout arms.
       */
      function captureEachBatch(): {
        get: () => (payload: EachBatchPayload) => Promise<void>;
      } {
        let captured:
          | ((payload: EachBatchPayload) => Promise<void>)
          | undefined;
        consumer.run.mockImplementation((opts) => {
          captured = opts?.eachBatch;
          return new Promise<void>(() => {});
        });
        return {
          get: () => {
            if (!captured) throw new Error("eachBatch not captured yet");
            return captured;
          },
        };
      }

      function runtime() {
        return runtimeWith(
          { kafka: { bootstrap_servers: "broker:9092" } },
          DEFAULT_CONNECTION_ID,
          clientManager,
        );
      }

      /**
       * Deliver a single-message batch on `orders`/partition 0. `lastOffset`
       * stays at the fake message's offset (42) — well below the default
       * 1,000,000 high-water mark — so a plain `deliver` never trips the
       * end-of-log exit. Tests that want that exit pass an explicit batch via
       * {@link deliverBatch}.
       */
      function deliver(
        each: (payload: EachBatchPayload) => Promise<void>,
        value: string,
      ): Promise<void> {
        return deliverBatch(each, { values: [value] });
      }

      /**
       * Deliver a batch with full control over topic/partition/offsets, for
       * the end-of-log cases. `lastOffset()` reports `lastOffset` (default:
       * the last message's offset) so the handler can compare it to the
       * partition's high-water target.
       */
      function deliverBatch(
        each: (payload: EachBatchPayload) => Promise<void>,
        opts: {
          topic?: string;
          partition?: number;
          values: string[];
          lastOffset?: string;
          highWatermark?: string;
        },
      ): Promise<void> {
        const messages = opts.values.map((value) =>
          fakeMessage({ value: Buffer.from(value) }),
        );
        const lastOffset =
          opts.lastOffset ?? messages[messages.length - 1]!.offset;
        return each({
          batch: {
            topic: opts.topic ?? "orders",
            partition: opts.partition ?? 0,
            highWatermark: opts.highWatermark ?? "1000000",
            messages,
            lastOffset: () => lastOffset,
          },
        } as unknown as EachBatchPayload);
      }

      it("should reject an invalid regex up front without building a consumer", async () => {
        const result = await handler.handle(runtime(), {
          topicNames: ["orders"],
          query: "(",
          queryMode: "regex",
        });
        const text = result.content
          .map((c) => ("text" in c ? c.text : ""))
          .join("");
        expect(result.isError).toBe(true);
        expect(text).toContain("Invalid regex query");
        expect(clientManager.buildKafkaConsumer).not.toHaveBeenCalled();
      });

      it("should subscribe from earliest with a per-call group id", async () => {
        const each = captureEachBatch();
        const handlePromise = handler.handle(runtime(), {
          topicNames: ["orders"],
          query: "needle",
          maxScanned: 1,
        });
        await new Promise<void>((r) => setImmediate(r));
        await deliver(each.get(), "needle");
        await handlePromise;

        expect(clientManager.buildKafkaConsumer).toHaveBeenCalledWith({
          clusterId: undefined,
          envId: undefined,
          groupId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
          offsetReset: "earliest",
        });
        expect(consumer.subscribe).toHaveBeenCalledWith({ topics: ["orders"] });
        expect(consumer.disconnect).toHaveBeenCalledOnce();
      });

      it("should scan partitions concurrently, defaulting to 4 and honoring an explicit value", async () => {
        const each = captureEachBatch();
        const handlePromise = handler.handle(runtime(), {
          topicNames: ["orders"],
          query: "needle",
          maxScanned: 1,
        });
        await new Promise<void>((r) => setImmediate(r));
        await deliver(each.get(), "needle");
        await handlePromise;
        expect(consumer.run).toHaveBeenCalledWith(
          expect.objectContaining({ partitionsConsumedConcurrently: 4 }),
        );

        const explicit = captureEachBatch();
        const explicitPromise = handler.handle(runtime(), {
          topicNames: ["orders"],
          query: "needle",
          maxScanned: 1,
          partitionConcurrency: 12,
        });
        await new Promise<void>((r) => setImmediate(r));
        await deliver(explicit.get(), "needle");
        await explicitPromise;
        expect(consumer.run).toHaveBeenLastCalledWith(
          expect.objectContaining({ partitionsConsumedConcurrently: 12 }),
        );
      });

      it("should trim matches to maxMatches even if concurrent workers overshoot", async () => {
        const each = captureEachBatch();
        const handlePromise = handler.handle(runtime(), {
          topicNames: ["orders"],
          query: "hit",
          maxMatches: 1,
          maxScanned: 3,
        });
        await new Promise<void>((r) => setImmediate(r));
        const fn = each.get();
        // Two matching deliveries race in before `accepting` flips; the
        // response must still report exactly maxMatches (1).
        await Promise.all([
          deliver(fn, "hit one"),
          deliver(fn, "hit two"),
          deliver(fn, "hit three"),
        ]);
        const result = await handlePromise;

        const text = result.content
          .map((c) => ("text" in c ? c.text : ""))
          .join("");
        expect(text).toContain("Found 1 matches in");
      });

      it("should deduplicate repeated topic names before subscribing", async () => {
        const each = captureEachBatch();
        const handlePromise = handler.handle(runtime(), {
          topicNames: ["orders", "orders", "audit"],
          query: "needle",
          maxScanned: 1,
        });
        await new Promise<void>((r) => setImmediate(r));
        await deliver(each.get(), "needle");
        await handlePromise;

        expect(consumer.subscribe).toHaveBeenCalledWith({
          topics: ["orders", "audit"],
        });
      });

      it("should return only matching messages and a Found/scanned summary", async () => {
        const each = captureEachBatch();
        const handlePromise = handler.handle(runtime(), {
          topicNames: ["orders"],
          query: "cust-42",
          // maxScanned === number of deliveries, so the race ends on the
          // last delivery without relying on the timeout.
          maxScanned: 3,
        });
        await new Promise<void>((r) => setImmediate(r));
        const fn = each.get();
        await deliver(fn, "order for cust-42 placed");
        await deliver(fn, "order for cust-99 placed");
        await deliver(fn, "refund for cust-42 issued");
        const result = await handlePromise;

        const text = result.content
          .map((c) => ("text" in c ? c.text : ""))
          .join("");
        expect(result.isError).toBe(false);
        expect(text).toContain(
          "Found 2 matches in 3 scanned messages from topics orders",
        );
        // Only the two matching values are present in the serialized matches.
        expect(text).toContain("cust-42 placed");
        expect(text).toContain("refund for cust-42");
        expect(text).not.toContain("cust-99");
      });

      it("should stop once maxMatches matches are found and suppress later deliveries", async () => {
        const each = captureEachBatch();
        const handlePromise = handler.handle(runtime(), {
          topicNames: ["orders"],
          query: "hit",
          maxMatches: 2,
        });
        await new Promise<void>((r) => setImmediate(r));
        const fn = each.get();
        await deliver(fn, "hit one");
        await deliver(fn, "hit two");
        // Third delivery arrives after the bound fired; the accepting gate
        // drops it so it is neither matched nor scanned.
        await deliver(fn, "hit three");
        const result = await handlePromise;

        const text = result.content
          .map((c) => ("text" in c ? c.text : ""))
          .join("");
        expect(text).toContain(
          "Found 2 matches in 2 scanned messages from topics orders",
        );
        expect(text).not.toContain("hit three");
      });

      it("should stop scanning at maxScanned even with no matches", async () => {
        const each = captureEachBatch();
        const handlePromise = handler.handle(runtime(), {
          topicNames: ["orders"],
          query: "never-present",
          maxScanned: 2,
        });
        await new Promise<void>((r) => setImmediate(r));
        const fn = each.get();
        await deliver(fn, "alpha");
        await deliver(fn, "beta");
        await deliver(fn, "gamma");
        const result = await handlePromise;

        const text = result.content
          .map((c) => ("text" in c ? c.text : ""))
          .join("");
        expect(text).toContain(
          "Found 0 matches in 2 scanned messages from topics orders",
        );
      });

      it("should return a tool error when consumer.run rejects", async () => {
        consumer.run.mockRejectedValue(new Error("group rebalance failed"));
        const result = await handler.handle(runtime(), {
          topicNames: ["orders"],
          query: "x",
        });
        const text = result.content
          .map((c) => ("text" in c ? c.text : ""))
          .join("");
        expect(result.isError).toBe(true);
        expect(text).toContain("Failed to search messages");
        expect(consumer.disconnect).toHaveBeenCalledOnce();
      });

      it("should stop at end-of-log once every partition reaches its start-of-search high-water mark, without waiting out the timeout", async () => {
        // High-water mark 50 → last existing offset is 49. A batch whose
        // lastOffset reaches 49 drains the only partition, so the search must
        // resolve via the end-of-log arm even though maxScanned (1000) and
        // the 10s default timeout are nowhere near.
        admin.fetchTopicOffsets.mockResolvedValue([
          { partition: 0, low: "0", high: "50", offset: "0" },
        ] as unknown as Awaited<ReturnType<typeof admin.fetchTopicOffsets>>);
        const each = captureEachBatch();
        const handlePromise = handler.handle(runtime(), {
          topicNames: ["orders"],
          query: "never-present",
        });
        await new Promise<void>((r) => setImmediate(r));
        await deliverBatch(each.get(), {
          values: ["alpha", "beta"],
          lastOffset: "49",
        });
        const result = await handlePromise;

        const text = result.content
          .map((c) => ("text" in c ? c.text : ""))
          .join("");
        expect(result.isError).toBe(false);
        // Both records in the batch were scanned before the partition drained.
        expect(text).toContain(
          "Found 0 matches in 2 scanned messages from topics orders",
        );
        expect(consumer.disconnect).toHaveBeenCalledOnce();
      });

      it("should finish immediately when every target partition is empty (nothing to scan)", async () => {
        // low === high on every partition → no records exist, so the search is
        // already at end-of-log and resolves without any delivery.
        admin.fetchTopicOffsets.mockResolvedValue([
          { partition: 0, low: "0", high: "0", offset: "0" },
        ] as unknown as Awaited<ReturnType<typeof admin.fetchTopicOffsets>>);
        captureEachBatch();
        const result = await handler.handle(runtime(), {
          topicNames: ["orders"],
          query: "anything",
        });
        const text = result.content
          .map((c) => ("text" in c ? c.text : ""))
          .join("");
        expect(result.isError).toBe(false);
        expect(text).toContain(
          "Found 0 matches in 0 scanned messages from topics orders",
        );
      });

      it("should still search (bounded by maxScanned) when the watermark fetch fails, dropping only the early exit", async () => {
        // Best-effort: an admin failure disables end-of-log but must not fail
        // the search — it falls back to the maxScanned/timeout bounds.
        admin.fetchTopicOffsets.mockRejectedValue(new Error("broker timeout"));
        const each = captureEachBatch();
        const handlePromise = handler.handle(runtime(), {
          topicNames: ["orders"],
          query: "hit",
          maxScanned: 2,
        });
        await new Promise<void>((r) => setImmediate(r));
        const fn = each.get();
        await deliver(fn, "hit one");
        await deliver(fn, "hit two");
        const result = await handlePromise;

        const text = result.content
          .map((c) => ("text" in c ? c.text : ""))
          .join("");
        expect(result.isError).toBe(false);
        expect(text).toContain(
          "Found 2 matches in 2 scanned messages from topics orders",
        );
      });
    });
  });
});
