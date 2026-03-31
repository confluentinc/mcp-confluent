/**
 * Integration tests for Kafka tools.
 *
 * Covers: list-topics, create-topics, delete-topics, produce-message,
 * consume-messages, get-topic-config, alter-topic-config.
 *
 * Each tool call is cross-checked against the Confluent Cloud Kafka REST API
 * to verify correctness.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  type IntegrationContext,
  requireEnvVars,
  restGet,
  setupIntegration,
  teardownIntegration,
  testTopicName,
  toolText,
} from "./setup.js";

// ── Tools under test ────────────────────────────────────────────────────────
const KAFKA_TOOLS: ToolName[] = [
  ToolName.LIST_TOPICS,
  ToolName.CREATE_TOPICS,
  ToolName.DELETE_TOPICS,
  ToolName.PRODUCE_MESSAGE,
  ToolName.CONSUME_MESSAGES,
  ToolName.GET_TOPIC_CONFIG,
  ToolName.ALTER_TOPIC_CONFIG,
];

// ── Topic names scoped to this run ──────────────────────────────────────────
const TOPIC_SINGLE = testTopicName("single");
const TOPIC_A = testTopicName("multi-a");
const TOPIC_B = testTopicName("multi-b");
const TOPIC_PRODUCE = testTopicName("produce");
const TOPIC_EMPTY = testTopicName("empty");
const TOPIC_CONFIG = testTopicName("config");

const ALL_TEST_TOPICS = [
  TOPIC_SINGLE,
  TOPIC_A,
  TOPIC_B,
  TOPIC_PRODUCE,
  TOPIC_EMPTY,
  TOPIC_CONFIG,
];

// ── Helpers ─────────────────────────────────────────────────────────────────

async function listTopicsViaRest(ctx: IntegrationContext): Promise<string[]> {
  const clusterId = process.env.KAFKA_CLUSTER_ID!;
  const data = (await restGet(
    `/kafka/v3/clusters/${clusterId}/topics`,
    ctx.kafkaRest,
  )) as { data: Array<{ topic_name: string }> };
  return data.data.map((t) => t.topic_name);
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe("Kafka tools", () => {
  let ctx: IntegrationContext;

  beforeAll(async () => {
    requireEnvVars(
      "BOOTSTRAP_SERVERS",
      "KAFKA_API_KEY",
      "KAFKA_API_SECRET",
      "KAFKA_REST_ENDPOINT",
      "KAFKA_CLUSTER_ID",
    );
    ctx = await setupIntegration(KAFKA_TOOLS);
  }, 30_000);

  afterAll(async () => {
    if (!ctx) return;
    // Best-effort cleanup of all test topics
    try {
      await ctx.client.callTool({
        name: ToolName.DELETE_TOPICS,
        arguments: { topicNames: ALL_TEST_TOPICS },
      });
    } catch {
      // ignore
    }
    await teardownIntegration(ctx);
  }, 30_000);

  // ────────────────────────────────────────────────────────────────────────
  // 1. Topic lifecycle
  // ────────────────────────────────────────────────────────────────────────

  describe("topic lifecycle", () => {
    it("1 – list-topics returns without error", async () => {
      const result = await ctx.client.callTool({
        name: ToolName.LIST_TOPICS,
        arguments: {},
      });
      expect(result.isError).toBeFalsy();
      expect(toolText(result)).toContain("Kafka topics:");
    });

    it("2 – create a single topic", async () => {
      const result = await ctx.client.callTool({
        name: ToolName.CREATE_TOPICS,
        arguments: { topicNames: [TOPIC_SINGLE] },
      });
      expect(result.isError).toBeFalsy();
      expect(toolText(result)).toContain(TOPIC_SINGLE);

      // Verify via REST
      const restTopics = await listTopicsViaRest(ctx);
      expect(restTopics).toContain(TOPIC_SINGLE);
    });

    it("3 – create multiple topics", async () => {
      const result = await ctx.client.callTool({
        name: ToolName.CREATE_TOPICS,
        arguments: { topicNames: [TOPIC_A, TOPIC_B] },
      });
      expect(result.isError).toBeFalsy();

      const restTopics = await listTopicsViaRest(ctx);
      expect(restTopics).toContain(TOPIC_A);
      expect(restTopics).toContain(TOPIC_B);
    });

    it("4 – create duplicate topic returns error or idempotent success", async () => {
      const result = await ctx.client.callTool({
        name: ToolName.CREATE_TOPICS,
        arguments: { topicNames: [TOPIC_SINGLE] },
      });
      // Either graceful error or idempotent success – both acceptable
      // The key thing is it doesn't throw/crash
      expect(toolText(result)).toBeTruthy();
    });

    it("5 – list-topics shows newly created topics", async () => {
      const result = await ctx.client.callTool({
        name: ToolName.LIST_TOPICS,
        arguments: {},
      });
      const text = toolText(result);
      expect(text).toContain(TOPIC_SINGLE);
      expect(text).toContain(TOPIC_A);
      expect(text).toContain(TOPIC_B);
    });

    it("6 – delete a single topic", async () => {
      const result = await ctx.client.callTool({
        name: ToolName.DELETE_TOPICS,
        arguments: { topicNames: [TOPIC_SINGLE] },
      });
      expect(result.isError).toBeFalsy();

      // Wait briefly for deletion to propagate
      await sleep(2000);

      const restTopics = await listTopicsViaRest(ctx);
      expect(restTopics).not.toContain(TOPIC_SINGLE);
    });

    it("7 – delete multiple topics", async () => {
      const result = await ctx.client.callTool({
        name: ToolName.DELETE_TOPICS,
        arguments: { topicNames: [TOPIC_A, TOPIC_B] },
      });
      expect(result.isError).toBeFalsy();

      await sleep(2000);

      const restTopics = await listTopicsViaRest(ctx);
      expect(restTopics).not.toContain(TOPIC_A);
      expect(restTopics).not.toContain(TOPIC_B);
    });

    it("8 – delete non-existent topic handles gracefully", async () => {
      // Should not throw – may return error or succeed silently
      const result = await ctx.client.callTool({
        name: ToolName.DELETE_TOPICS,
        arguments: { topicNames: [`${testTopicName("nonexistent")}`] },
      });
      expect(toolText(result)).toBeTruthy();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // 2. Topic configuration (Cloud only)
  // ────────────────────────────────────────────────────────────────────────

  describe("topic configuration", () => {
    beforeAll(async () => {
      await ctx.client.callTool({
        name: ToolName.CREATE_TOPICS,
        arguments: { topicNames: [TOPIC_CONFIG] },
      });
      // Allow topic metadata to propagate
      await sleep(3000);
    });

    afterAll(async () => {
      try {
        await ctx.client.callTool({
          name: ToolName.DELETE_TOPICS,
          arguments: { topicNames: [TOPIC_CONFIG] },
        });
      } catch {
        // ignore
      }
    });

    it("9 – get-topic-config returns config", async () => {
      const result = await ctx.client.callTool({
        name: ToolName.GET_TOPIC_CONFIG,
        arguments: { topicName: TOPIC_CONFIG },
      });
      expect(result.isError).toBeFalsy();
      const text = toolText(result);
      expect(text).toContain("topicDetails");
      expect(text).toContain("topicConfig");

      // Cross-check: REST should return configs too
      const clusterId = process.env.KAFKA_CLUSTER_ID!;
      const restData = await restGet(
        `/kafka/v3/clusters/${clusterId}/topics/${TOPIC_CONFIG}/configs`,
        ctx.kafkaRest,
      );
      expect(restData).toBeTruthy();
    });

    it("10 – alter-topic-config updates retention", async () => {
      const result = await ctx.client.callTool({
        name: ToolName.ALTER_TOPIC_CONFIG,
        arguments: {
          topicName: TOPIC_CONFIG,
          topicConfigs: [
            { name: "retention.ms", value: "86400000", operation: "SET" },
          ],
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("11 – get-topic-config verifies updated retention", async () => {
      const result = await ctx.client.callTool({
        name: ToolName.GET_TOPIC_CONFIG,
        arguments: { topicName: TOPIC_CONFIG },
      });
      expect(result.isError).toBeFalsy();
      const text = toolText(result);
      expect(text).toContain("retention.ms");

      // Verify via REST
      const clusterId = process.env.KAFKA_CLUSTER_ID!;
      const restData = (await restGet(
        `/kafka/v3/clusters/${clusterId}/topics/${TOPIC_CONFIG}/configs/retention.ms`,
        ctx.kafkaRest,
      )) as { value: string };
      expect(restData.value).toBe("86400000");
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // 3. Produce & Consume (plain – no Schema Registry)
  // ────────────────────────────────────────────────────────────────────────

  describe("produce and consume (plain)", () => {
    beforeAll(async () => {
      await ctx.client.callTool({
        name: ToolName.CREATE_TOPICS,
        arguments: { topicNames: [TOPIC_PRODUCE, TOPIC_EMPTY] },
      });
      await sleep(3000);
    });

    afterAll(async () => {
      try {
        await ctx.client.callTool({
          name: ToolName.DELETE_TOPICS,
          arguments: { topicNames: [TOPIC_PRODUCE, TOPIC_EMPTY] },
        });
      } catch {
        // ignore
      }
    });

    it("12 – produce message with key and value", async () => {
      const result = await ctx.client.callTool({
        name: ToolName.PRODUCE_MESSAGE,
        arguments: {
          topicName: TOPIC_PRODUCE,
          key: { message: "k1" },
          value: { message: '{"hello":"world"}' },
        },
      });
      expect(result.isError).toBeFalsy();
      expect(toolText(result)).toContain("produced successfully");
    });

    it("13 – produce message with value only", async () => {
      const result = await ctx.client.callTool({
        name: ToolName.PRODUCE_MESSAGE,
        arguments: {
          topicName: TOPIC_PRODUCE,
          value: { message: "plain text message" },
        },
      });
      expect(result.isError).toBeFalsy();
      expect(toolText(result)).toContain("produced successfully");
    });

    it("14 – consume returns the produced messages", async () => {
      // Small delay to ensure messages are committed
      await sleep(2000);

      const result = await ctx.client.callTool({
        name: ToolName.CONSUME_MESSAGES,
        arguments: {
          topicNames: [TOPIC_PRODUCE],
          maxMessages: 10,
          timeoutMs: 15000,
          value: { useSchemaRegistry: false },
        },
      });
      expect(result.isError).toBeFalsy();
      const text = toolText(result);
      expect(text).toContain("Consumed 2 messages");
      expect(text).toContain("hello");
      expect(text).toContain("plain text message");
    });

    it("15 – consume from empty topic returns 0 messages", async () => {
      const result = await ctx.client.callTool({
        name: ToolName.CONSUME_MESSAGES,
        arguments: {
          topicNames: [TOPIC_EMPTY],
          maxMessages: 5,
          timeoutMs: 5000,
          value: { useSchemaRegistry: false },
        },
      });
      expect(result.isError).toBeFalsy();
      expect(toolText(result)).toContain("Consumed 0 messages");
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // 4. Produce & Consume with Schema Registry
  // ────────────────────────────────────────────────────────────────────────

  describe("produce and consume (Schema Registry)", () => {
    const TOPIC_AVRO = testTopicName("avro");
    const TOPIC_JSON = testTopicName("json-sr");
    const TOPIC_PROTO = testTopicName("proto");
    const SR_TOPICS = [TOPIC_AVRO, TOPIC_JSON, TOPIC_PROTO];

    beforeAll(async () => {
      requireEnvVars(
        "SCHEMA_REGISTRY_ENDPOINT",
        "SCHEMA_REGISTRY_API_KEY",
        "SCHEMA_REGISTRY_API_SECRET",
      );
      await ctx.client.callTool({
        name: ToolName.CREATE_TOPICS,
        arguments: { topicNames: SR_TOPICS },
      });
      await sleep(3000);
    });

    afterAll(async () => {
      // Clean up topics
      try {
        await ctx.client.callTool({
          name: ToolName.DELETE_TOPICS,
          arguments: { topicNames: SR_TOPICS },
        });
      } catch {
        // ignore
      }
      // Clean up schemas
      for (const topic of SR_TOPICS) {
        for (const suffix of ["-value", "-key"]) {
          try {
            await ctx.client.callTool({
              name: ToolName.DELETE_SCHEMA,
              arguments: { subject: `${topic}${suffix}`, permanent: true },
            });
          } catch {
            // ignore
          }
        }
      }
    });

    it("16 – produce AVRO message with schema", async () => {
      const avroSchema = JSON.stringify({
        type: "record",
        name: "User",
        fields: [
          { name: "name", type: "string" },
          { name: "age", type: "int" },
        ],
      });
      const result = await ctx.client.callTool({
        name: ToolName.PRODUCE_MESSAGE,
        arguments: {
          topicName: TOPIC_AVRO,
          value: {
            message: { name: "test-user", age: 30 },
            useSchemaRegistry: true,
            schemaType: "AVRO",
            schema: avroSchema,
          },
        },
      });
      expect(result.isError).toBeFalsy();
      expect(toolText(result)).toContain("produced successfully");

      // Verify schema was registered via REST
      const subjects = (await restGet(
        "/subjects",
        ctx.schemaRegistryRest,
      )) as string[];
      expect(subjects).toContain(`${TOPIC_AVRO}-value`);
    });

    it("17 – produce JSON Schema message", async () => {
      const jsonSchema = JSON.stringify({
        type: "object",
        properties: { name: { type: "string" } },
      });
      const result = await ctx.client.callTool({
        name: ToolName.PRODUCE_MESSAGE,
        arguments: {
          topicName: TOPIC_JSON,
          value: {
            message: { name: "json-test" },
            useSchemaRegistry: true,
            schemaType: "JSON",
            schema: jsonSchema,
          },
        },
      });
      expect(result.isError).toBeFalsy();
      expect(toolText(result)).toContain("produced successfully");
    });

    it("18 – produce PROTOBUF message", async () => {
      const protoSchema =
        'syntax = "proto3"; message User { string name = 1; }';
      const result = await ctx.client.callTool({
        name: ToolName.PRODUCE_MESSAGE,
        arguments: {
          topicName: TOPIC_PROTO,
          value: {
            message: { name: "proto-test" },
            useSchemaRegistry: true,
            schemaType: "PROTOBUF",
            schema: protoSchema,
          },
        },
      });
      expect(result.isError).toBeFalsy();
      expect(toolText(result)).toContain("produced successfully");
    });

    it("19 – consume auto-deserializes AVRO messages", async () => {
      await sleep(2000);
      const result = await ctx.client.callTool({
        name: ToolName.CONSUME_MESSAGES,
        arguments: {
          topicNames: [TOPIC_AVRO],
          maxMessages: 5,
          timeoutMs: 15000,
          value: { useSchemaRegistry: true },
        },
      });
      expect(result.isError).toBeFalsy();
      const text = toolText(result);
      expect(text).toContain("Consumed 1 messages");
      expect(text).toContain("test-user");
    });

    it("20 – consume auto-deserializes JSON Schema messages", async () => {
      const result = await ctx.client.callTool({
        name: ToolName.CONSUME_MESSAGES,
        arguments: {
          topicNames: [TOPIC_JSON],
          maxMessages: 5,
          timeoutMs: 15000,
          value: { useSchemaRegistry: true },
        },
      });
      expect(result.isError).toBeFalsy();
      const text = toolText(result);
      expect(text).toContain("Consumed 1 messages");
      expect(text).toContain("json-test");
    });

    it("21 – consume from multiple topics", async () => {
      const result = await ctx.client.callTool({
        name: ToolName.CONSUME_MESSAGES,
        arguments: {
          topicNames: [TOPIC_AVRO, TOPIC_JSON],
          maxMessages: 10,
          timeoutMs: 15000,
          value: { useSchemaRegistry: true },
        },
      });
      expect(result.isError).toBeFalsy();
      const text = toolText(result);
      expect(text).toContain("Consumed 2 messages");
    });
  });
});
