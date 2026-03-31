/**
 * Integration tests for Confluent Cloud infrastructure, Connect, Catalog,
 * Search, and Billing tools.
 *
 * Each tool call is cross-checked against the Confluent Cloud REST API where
 * applicable.
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

// ── All tools used across the sub-suites ────────────────────────────────────
const ALL_TOOLS: ToolName[] = [
  ToolName.LIST_ENVIRONMENTS,
  ToolName.READ_ENVIRONMENT,
  ToolName.LIST_CLUSTERS,
  ToolName.LIST_BILLING_COSTS,
  ToolName.LIST_CONNECTORS,
  ToolName.READ_CONNECTOR,
  ToolName.LIST_TAGS,
  ToolName.CREATE_TOPIC_TAGS,
  ToolName.ADD_TAGS_TO_TOPIC,
  ToolName.SEARCH_TOPICS_BY_TAG,
  ToolName.SEARCH_TOPICS_BY_NAME,
  ToolName.REMOVE_TAG_FROM_ENTITY,
  ToolName.DELETE_TAG,
  ToolName.CREATE_TOPICS,
  ToolName.DELETE_TOPICS,
];

// ── Helpers ─────────────────────────────────────────────────────────────────

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe("Cloud, Connect, Catalog & Search tools", () => {
  let ctx: IntegrationContext;

  beforeAll(async () => {
    requireEnvVars("CONFLUENT_CLOUD_API_KEY", "CONFLUENT_CLOUD_API_SECRET");
    ctx = await setupIntegration(ALL_TOOLS);
  }, 30_000);

  afterAll(async () => {
    if (ctx) await teardownIntegration(ctx);
  }, 30_000);

  // ────────────────────────────────────────────────────────────────────────
  // 3. Cloud Infrastructure
  // ────────────────────────────────────────────────────────────────────────

  describe("cloud infrastructure", () => {
    let firstEnvId: string;

    it("31 – list-environments returns environments", async () => {
      const result = await ctx.client.callTool({
        name: ToolName.LIST_ENVIRONMENTS,
        arguments: {},
      });
      expect(result.isError).toBeFalsy();
      const text = toolText(result);
      expect(text).toBeTruthy();

      // Cross-check via REST
      const restData = (await restGet(
        "/org/v2/environments",
        ctx.cloudRest,
      )) as { data: Array<{ id: string }> };
      expect(restData.data.length).toBeGreaterThan(0);
      firstEnvId = restData.data[0]!.id;
    });

    it("32 – read-environment returns details for a specific env", async () => {
      expect(firstEnvId).toBeTruthy();
      const result = await ctx.client.callTool({
        name: ToolName.READ_ENVIRONMENT,
        arguments: { environmentId: firstEnvId },
      });
      expect(result.isError).toBeFalsy();
      expect(toolText(result)).toContain(firstEnvId);

      // Cross-check via REST
      const restData = (await restGet(
        `/org/v2/environments/${firstEnvId}`,
        ctx.cloudRest,
      )) as { id: string };
      expect(restData.id).toBe(firstEnvId);
    });

    it("33 – list-clusters returns clusters", async () => {
      const result = await ctx.client.callTool({
        name: ToolName.LIST_CLUSTERS,
        arguments: {},
      });
      expect(result.isError).toBeFalsy();
      expect(toolText(result)).toBeTruthy();

      // Cross-check via REST
      const restData = (await restGet(
        "/cmk/v2/clusters?page_size=10",
        ctx.cloudRest,
      )) as { data: unknown[] };
      expect(restData.data.length).toBeGreaterThan(0);
    });

    it("34 – list-billing-costs returns cost data", async () => {
      const result = await ctx.client.callTool({
        name: ToolName.LIST_BILLING_COSTS,
        arguments: {
          startDate: "2025-01-01",
          endDate: "2025-01-31",
        },
      });
      expect(result.isError).toBeFalsy();
      expect(toolText(result)).toBeTruthy();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // 4. Kafka Connect
  // ────────────────────────────────────────────────────────────────────────

  describe("kafka connect", () => {
    it("35 – list-connectors returns connector names", async () => {
      requireEnvVars("KAFKA_ENV_ID", "KAFKA_CLUSTER_ID");
      const result = await ctx.client.callTool({
        name: ToolName.LIST_CONNECTORS,
        arguments: {},
      });
      // May return empty list or list of connectors – should not error
      expect(result.isError).toBeFalsy();
    });

    it("36 – read-connector returns details (if any exist)", async () => {
      requireEnvVars("KAFKA_ENV_ID", "KAFKA_CLUSTER_ID");
      // First list to find a connector name
      const listResult = await ctx.client.callTool({
        name: ToolName.LIST_CONNECTORS,
        arguments: {},
      });
      const text = toolText(listResult);

      // If no connectors exist, skip the read test
      if (text.includes("[]") || text.includes("No connectors")) {
        return; // nothing to read
      }

      // Try to extract a connector name from the response
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed) || parsed.length === 0) return;

      const connectorName = parsed[0];
      const result = await ctx.client.callTool({
        name: ToolName.READ_CONNECTOR,
        arguments: { connectorName },
      });
      expect(result.isError).toBeFalsy();
      expect(toolText(result)).toContain(connectorName);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // 5. Catalog & Tagging + Search
  // ────────────────────────────────────────────────────────────────────────

  describe("catalog, tagging & search", () => {
    const TAG_NAME = `inttest_tag_${Date.now().toString(36)}`;
    const TAG_TOPIC = testTopicName("tag-target");

    // We need a topic with a qualified name for tagging.
    // Qualified name format: <clusterType>:<clusterId>:<topicName>
    // We'll derive it from env vars.
    let qualifiedName: string;

    beforeAll(async () => {
      requireEnvVars(
        "SCHEMA_REGISTRY_API_KEY",
        "SCHEMA_REGISTRY_API_SECRET",
        "SCHEMA_REGISTRY_ENDPOINT",
        "KAFKA_CLUSTER_ID",
      );

      // Create target topic
      await ctx.client.callTool({
        name: ToolName.CREATE_TOPICS,
        arguments: { topicNames: [TAG_TOPIC] },
      });
      await sleep(5000); // wait for topic to propagate to catalog

      // Discover the qualified name via search
      const searchResult = await ctx.client.callTool({
        name: ToolName.SEARCH_TOPICS_BY_NAME,
        arguments: { topicName: TAG_TOPIC },
      });
      const searchText = toolText(searchResult);

      // Try to extract qualified name from the response
      const qnMatch = searchText.match(/lkc-[a-zA-Z0-9]+:[^"',\s\]]+/);
      if (qnMatch) {
        qualifiedName = qnMatch[0];
      } else {
        // Fall back to constructing it
        qualifiedName = `${process.env.KAFKA_CLUSTER_ID}:${TAG_TOPIC}`;
      }
    }, 30_000);

    afterAll(async () => {
      // Clean up: remove tag from topic, delete tag, delete topic
      try {
        await ctx.client.callTool({
          name: ToolName.REMOVE_TAG_FROM_ENTITY,
          arguments: { tagName: TAG_NAME, qualifiedName },
        });
      } catch {
        // ignore
      }
      try {
        await ctx.client.callTool({
          name: ToolName.DELETE_TAG,
          arguments: { tagName: TAG_NAME },
        });
      } catch {
        // ignore
      }
      try {
        await ctx.client.callTool({
          name: ToolName.DELETE_TOPICS,
          arguments: { topicNames: [TAG_TOPIC] },
        });
      } catch {
        // ignore
      }
    }, 30_000);

    it("37 – list-tags returns tag definitions", async () => {
      const result = await ctx.client.callTool({
        name: ToolName.LIST_TAGS,
        arguments: {},
      });
      expect(result.isError).toBeFalsy();
      expect(toolText(result)).toBeTruthy();
    });

    it("38 – create-topic-tags creates a tag", async () => {
      const result = await ctx.client.callTool({
        name: ToolName.CREATE_TOPIC_TAGS,
        arguments: {
          tags: [{ tagName: TAG_NAME, description: "Integration test tag" }],
        },
      });
      expect(result.isError).toBeFalsy();
      expect(toolText(result)).toContain(TAG_NAME);

      // Verify via list-tags
      const listResult = await ctx.client.callTool({
        name: ToolName.LIST_TAGS,
        arguments: {},
      });
      expect(toolText(listResult)).toContain(TAG_NAME);
    });

    it("39 – add-tags-to-topic assigns tag to topic", async () => {
      expect(qualifiedName).toBeTruthy();

      const result = await ctx.client.callTool({
        name: ToolName.ADD_TAGS_TO_TOPIC,
        arguments: {
          tagAssignments: [
            {
              entityType: "kafka_topic",
              entityName: qualifiedName,
              typeName: TAG_NAME,
            },
          ],
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("40 – search-topics-by-tag finds tagged topic", async () => {
      // Allow catalog sync
      await sleep(3000);

      const result = await ctx.client.callTool({
        name: ToolName.SEARCH_TOPICS_BY_TAG,
        arguments: { topicTag: TAG_NAME },
      });
      expect(result.isError).toBeFalsy();
      expect(toolText(result)).toContain(TAG_TOPIC);
    });

    it("41 – search-topics-by-name finds topic", async () => {
      const result = await ctx.client.callTool({
        name: ToolName.SEARCH_TOPICS_BY_NAME,
        arguments: { topicName: TAG_TOPIC },
      });
      expect(result.isError).toBeFalsy();
      expect(toolText(result)).toContain(TAG_TOPIC);
    });

    it("42 – remove-tag-from-entity removes tag from topic", async () => {
      const result = await ctx.client.callTool({
        name: ToolName.REMOVE_TAG_FROM_ENTITY,
        arguments: {
          tagName: TAG_NAME,
          qualifiedName,
        },
      });
      expect(result.isError).toBeFalsy();
    });

    it("43 – delete-tag removes tag definition", async () => {
      const result = await ctx.client.callTool({
        name: ToolName.DELETE_TAG,
        arguments: { tagName: TAG_NAME },
      });
      expect(result.isError).toBeFalsy();

      // Verify it's gone
      const listResult = await ctx.client.callTool({
        name: ToolName.LIST_TAGS,
        arguments: {},
      });
      expect(toolText(listResult)).not.toContain(TAG_NAME);
    });
  });
});
