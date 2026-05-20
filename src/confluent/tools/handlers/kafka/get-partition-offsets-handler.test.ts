import { CallToolResult } from "@src/confluent/schema.js";
import { GetPartitionOffsetsHandler } from "@src/confluent/tools/handlers/kafka/get-partition-offsets-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  bareRuntime,
  DEFAULT_CONNECTION_ID,
  kafkaRuntime,
  runtimeWith,
} from "@tests/factories/runtime.js";
import {
  getMockedClientManager,
  type MockedClientManager,
} from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

function buildRuntime(clientManager: MockedClientManager) {
  return runtimeWith(
    { kafka: { bootstrap_servers: "broker:9092" } },
    DEFAULT_CONNECTION_ID,
    clientManager,
  );
}

function textOf(result: CallToolResult): string {
  return result.content.map((c) => ("text" in c ? c.text : "")).join("");
}

describe("get-partition-offsets-handler.ts", () => {
  describe("getToolConfig()", () => {
    const handler = new GetPartitionOffsetsHandler();

    it("should expose the expected name, annotations, category, and input schema keys", () => {
      const config = handler.getToolConfig();
      expect(config.name).toBe(ToolName.GET_PARTITION_OFFSETS);
      expect(config.annotations.readOnlyHint).toBe(true);
      expect(Object.keys(config.inputSchema).sort()).toEqual([
        "cluster_id",
        "environment_id",
        "partition",
        "topicName",
      ]);
    });
  });

  describe("enabledConnectionIds()", () => {
    const handler = new GetPartitionOffsetsHandler();

    it("should enable on a kafka runtime", () => {
      expect(handler.enabledConnectionIds(kafkaRuntime())).toEqual([
        DEFAULT_CONNECTION_ID,
      ]);
    });

    it("should disable on a bare runtime", () => {
      expect(handler.enabledConnectionIds(bareRuntime())).toEqual([]);
    });
  });

  describe("handle()", () => {
    const handler = new GetPartitionOffsetsHandler();

    it("should return a structured payload with low/highWatermark as strings and computed messageCount for every partition", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchTopicOffsets.mockResolvedValue([
        { partition: 0, low: "0", high: "100", offset: "100" },
        { partition: 1, low: "50", high: "200", offset: "200" },
        { partition: 2, low: "0", high: "0", offset: "0" },
      ]);

      const result = await handler.handle(buildRuntime(clientManager), {
        topicName: "orders",
      });

      expect(admin.fetchTopicOffsets).toHaveBeenCalledOnce();
      expect(admin.fetchTopicOffsets).toHaveBeenCalledWith("orders");

      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual({
        topicName: "orders",
        partitions: [
          {
            partition: 0,
            lowWatermark: "0",
            highWatermark: "100",
            messageCount: 100,
          },
          {
            partition: 1,
            lowWatermark: "50",
            highWatermark: "200",
            messageCount: 150,
          },
          {
            partition: 2,
            lowWatermark: "0",
            highWatermark: "0",
            messageCount: 0,
          },
        ],
      });
      expect(textOf(result)).toContain(
        'Partition offsets for "orders" (3 partition(s))',
      );
    });

    it("should restrict the response to a single partition when the `partition` arg is supplied", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchTopicOffsets.mockResolvedValue([
        { partition: 0, low: "0", high: "100", offset: "100" },
        { partition: 1, low: "50", high: "200", offset: "200" },
        { partition: 2, low: "10", high: "20", offset: "20" },
      ]);

      const result = await handler.handle(buildRuntime(clientManager), {
        topicName: "orders",
        partition: 1,
      });

      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual({
        topicName: "orders",
        partitions: [
          {
            partition: 1,
            lowWatermark: "50",
            highWatermark: "200",
            messageCount: 150,
          },
        ],
      });
      expect(textOf(result)).toContain(
        'Partition offsets for "orders" (1 partition(s))',
      );
    });

    it("should return messageCount: 0 for an empty partition (low === high) without any special-case branch", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchTopicOffsets.mockResolvedValue([
        { partition: 0, low: "42", high: "42", offset: "42" },
      ]);

      const result = await handler.handle(buildRuntime(clientManager), {
        topicName: "empty-topic",
      });

      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual({
        topicName: "empty-topic",
        partitions: [
          {
            partition: 0,
            lowWatermark: "42",
            highWatermark: "42",
            messageCount: 0,
          },
        ],
      });
    });

    it("should preserve int64 precision when computing messageCount via BigInt subtraction (values past 2^53)", async () => {
      // JS Number arithmetic loses precision past Number.MAX_SAFE_INTEGER
      // (2^53 - 1). The handler must subtract via BigInt and then narrow,
      // so a three-message gap at the int64 boundary stays exactly 3.
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchTopicOffsets.mockResolvedValue([
        {
          partition: 0,
          low: "9007199254740990",
          high: "9007199254740993",
          offset: "9007199254740993",
        },
      ]);

      const result = await handler.handle(buildRuntime(clientManager), {
        topicName: "bigint-topic",
      });

      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual({
        topicName: "bigint-topic",
        partitions: [
          {
            partition: 0,
            lowWatermark: "9007199254740990",
            highWatermark: "9007199254740993",
            messageCount: 3,
          },
        ],
      });
    });

    it("should surface a clean 'topic not found' error when fetchTopicOffsets returns an empty array", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchTopicOffsets.mockResolvedValue([]);

      const result = await handler.handle(buildRuntime(clientManager), {
        topicName: "no-such-topic",
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(
        'Topic "no-such-topic" not found on this cluster',
      );
    });

    it("should surface a clean 'topic not found' error and not leak the librdkafka message when fetchTopicOffsets rejects with an unknown-topic error", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchTopicOffsets.mockRejectedValue(
        new Error("Broker: Unknown topic or partition"),
      );

      const result = await handler.handle(buildRuntime(clientManager), {
        topicName: "no-such-topic",
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(
        'Topic "no-such-topic" not found on this cluster',
      );
      // The librdkafka raw text should not be the headline; the clean
      // tool-level message wraps it.
      expect(textOf(result)).not.toMatch(
        /^Broker: Unknown topic or partition$/,
      );
    });

    it("should surface a clean out-of-range error citing the actual partition span when a `partition` arg is past the topic's range", async () => {
      const clientManager = getMockedClientManager();
      const admin = await clientManager.getAdminClient();
      admin.fetchTopicOffsets.mockResolvedValue([
        { partition: 0, low: "0", high: "10", offset: "10" },
        { partition: 1, low: "0", high: "20", offset: "20" },
        { partition: 2, low: "0", high: "30", offset: "30" },
      ]);

      const result = await handler.handle(buildRuntime(clientManager), {
        topicName: "orders",
        partition: 5,
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(
        'Topic "orders" has 3 partition(s) (0..2); requested partition 5 is out of range',
      );
    });

    it("should reject a missing topicName at the Zod boundary", async () => {
      const clientManager = getMockedClientManager();
      await expect(
        handler.handle(buildRuntime(clientManager), {}),
      ).rejects.toThrowError(/topicName/);
    });

    it("should reject an empty topicName at the Zod boundary", async () => {
      const clientManager = getMockedClientManager();
      await expect(
        handler.handle(buildRuntime(clientManager), { topicName: "" }),
      ).rejects.toThrowError(/topicName/);
    });

    it("should reject a negative partition at the Zod boundary", async () => {
      const clientManager = getMockedClientManager();
      await expect(
        handler.handle(buildRuntime(clientManager), {
          topicName: "orders",
          partition: -1,
        }),
      ).rejects.toThrowError(/partition/);
    });
  });
});
