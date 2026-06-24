import type {
  EachMessagePayload,
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

      beforeEach(async () => {
        clientManager = getMockedClientManager();
        consumer = await clientManager.getConsumer();
        consumer.connect.mockResolvedValue(undefined);
        consumer.subscribe.mockResolvedValue(undefined);
        consumer.disconnect.mockResolvedValue(undefined);
      });

      /**
       * Capture the handler's `eachMessage` callback so the test can drive
       * deliveries deterministically. `consumer.run` returns a
       * never-settling promise so the orchestrator's race only finishes via
       * the bounded (maxMatches/maxScanned) or timeout arms.
       */
      function captureEachMessage(): {
        get: () => (payload: EachMessagePayload) => Promise<void>;
      } {
        let captured:
          | ((payload: EachMessagePayload) => Promise<void>)
          | undefined;
        consumer.run.mockImplementation((opts) => {
          captured = opts?.eachMessage;
          return new Promise<void>(() => {});
        });
        return {
          get: () => {
            if (!captured) throw new Error("eachMessage not captured yet");
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

      function deliver(
        each: (payload: EachMessagePayload) => Promise<void>,
        value: string,
      ): Promise<void> {
        return each({
          topic: "orders",
          partition: 0,
          message: fakeMessage({ value: Buffer.from(value) }),
        } as unknown as EachMessagePayload);
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
        const each = captureEachMessage();
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

      it("should deduplicate repeated topic names before subscribing", async () => {
        const each = captureEachMessage();
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
        const each = captureEachMessage();
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
        const each = captureEachMessage();
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
        const each = captureEachMessage();
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
    });
  });
});
