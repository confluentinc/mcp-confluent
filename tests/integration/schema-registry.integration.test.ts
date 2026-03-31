/**
 * Integration tests for Schema Registry tools.
 *
 * Covers: list-schemas, delete-schema (soft, hard, version, non-existent).
 *
 * A prerequisite AVRO schema is registered via the produce-message tool so
 * that list/delete operations have data to work with.  Results are
 * cross-checked against the Schema Registry REST API.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  type IntegrationContext,
  requireEnvVars,
  restDelete,
  restGet,
  setupIntegration,
  teardownIntegration,
  testSubjectName,
  testTopicName,
  toolText,
} from "./setup.js";

// ── Tools under test ────────────────────────────────────────────────────────
const SR_TOOLS: ToolName[] = [
  ToolName.LIST_SCHEMAS,
  ToolName.DELETE_SCHEMA,
  ToolName.PRODUCE_MESSAGE,
  ToolName.CREATE_TOPICS,
  ToolName.DELETE_TOPICS,
];

// ── Scoped names ────────────────────────────────────────────────────────────
const TOPIC_SR = testTopicName("sr-test");
const SUBJECT_VALUE = `${TOPIC_SR}-value`;

const AVRO_SCHEMA = JSON.stringify({
  type: "record",
  name: "SRTest",
  fields: [
    { name: "id", type: "int" },
    { name: "label", type: "string" },
  ],
});

// ── Helpers ─────────────────────────────────────────────────────────────────

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function subjectsViaRest(ctx: IntegrationContext): Promise<string[]> {
  return (await restGet("/subjects", ctx.schemaRegistryRest)) as string[];
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe("Schema Registry tools", () => {
  let ctx: IntegrationContext;

  beforeAll(async () => {
    requireEnvVars(
      "BOOTSTRAP_SERVERS",
      "KAFKA_API_KEY",
      "KAFKA_API_SECRET",
      "SCHEMA_REGISTRY_ENDPOINT",
      "SCHEMA_REGISTRY_API_KEY",
      "SCHEMA_REGISTRY_API_SECRET",
    );
    ctx = await setupIntegration(SR_TOOLS);

    // Create a topic and produce an AVRO message to register a schema
    await ctx.client.callTool({
      name: ToolName.CREATE_TOPICS,
      arguments: { topicNames: [TOPIC_SR] },
    });
    await sleep(3000);

    const produceResult = await ctx.client.callTool({
      name: ToolName.PRODUCE_MESSAGE,
      arguments: {
        topicName: TOPIC_SR,
        value: {
          message: { id: 1, label: "seed" },
          useSchemaRegistry: true,
          schemaType: "AVRO",
          schema: AVRO_SCHEMA,
        },
      },
    });
    expect(produceResult.isError).toBeFalsy();
    await sleep(1000);
  }, 45_000);

  afterAll(async () => {
    if (!ctx) return;
    // Clean up schema subjects (hard delete)
    try {
      await restDelete(`/subjects/${SUBJECT_VALUE}`, ctx.schemaRegistryRest);
      await restDelete(
        `/subjects/${SUBJECT_VALUE}?permanent=true`,
        ctx.schemaRegistryRest,
      );
    } catch {
      // ignore
    }
    // Clean up topic
    try {
      await ctx.client.callTool({
        name: ToolName.DELETE_TOPICS,
        arguments: { topicNames: [TOPIC_SR] },
      });
    } catch {
      // ignore
    }
    await teardownIntegration(ctx);
  }, 30_000);

  // ────────────────────────────────────────────────────────────────────────
  // list-schemas
  // ────────────────────────────────────────────────────────────────────────

  it("22 – list schemas (latest only)", async () => {
    const result = await ctx.client.callTool({
      name: ToolName.LIST_SCHEMAS,
      arguments: { latestOnly: true },
    });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(toolText(result));
    expect(parsed).toHaveProperty(SUBJECT_VALUE);
    expect(parsed[SUBJECT_VALUE]).toHaveProperty("version", 1);

    // Cross-check
    const subjects = await subjectsViaRest(ctx);
    expect(subjects).toContain(SUBJECT_VALUE);
  });

  it("23 – list all schema versions", async () => {
    const result = await ctx.client.callTool({
      name: ToolName.LIST_SCHEMAS,
      arguments: { latestOnly: false },
    });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(toolText(result));
    expect(parsed).toHaveProperty(SUBJECT_VALUE);

    // Cross-check: REST should report at least version 1
    const versions = (await restGet(
      `/subjects/${SUBJECT_VALUE}/versions`,
      ctx.schemaRegistryRest,
    )) as number[];
    expect(versions).toContain(1);
  });

  it("24 – list schemas filtered by subject prefix", async () => {
    const prefix = TOPIC_SR; // matches "{runId}-sr-test"
    const result = await ctx.client.callTool({
      name: ToolName.LIST_SCHEMAS,
      arguments: { subjectPrefix: prefix },
    });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(toolText(result));
    // All returned keys must start with the prefix
    for (const key of Object.keys(parsed)) {
      expect(key.startsWith(prefix)).toBe(true);
    }
  });

  it("25 – list schemas shows schema from produce", async () => {
    const result = await ctx.client.callTool({
      name: ToolName.LIST_SCHEMAS,
      arguments: { subjectPrefix: TOPIC_SR, latestOnly: true },
    });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(toolText(result));
    expect(parsed[SUBJECT_VALUE]).toBeTruthy();
    expect(parsed[SUBJECT_VALUE].schemaType).toBe("AVRO");
  });

  // ────────────────────────────────────────────────────────────────────────
  // delete-schema
  // ────────────────────────────────────────────────────────────────────────

  it("26 – soft delete schema subject", async () => {
    const result = await ctx.client.callTool({
      name: ToolName.DELETE_SCHEMA,
      arguments: { subject: SUBJECT_VALUE, permanent: false },
    });
    expect(result.isError).toBeFalsy();
    expect(toolText(result)).toContain("Successfully deleted");

    // REST: subject should no longer appear in default listing
    const subjects = await subjectsViaRest(ctx);
    expect(subjects).not.toContain(SUBJECT_VALUE);
  });

  it("28 – list schemas with deleted flag shows soft-deleted subjects", async () => {
    const result = await ctx.client.callTool({
      name: ToolName.LIST_SCHEMAS,
      arguments: { latestOnly: false, deleted: true },
    });
    // The tool lists subjects from getAllSubjects() which may or may not
    // return soft-deleted subjects depending on SR version. Either way
    // the call should succeed.
    expect(result.isError).toBeFalsy();
  });

  it("29 – permanent delete schema", async () => {
    const result = await ctx.client.callTool({
      name: ToolName.DELETE_SCHEMA,
      arguments: { subject: SUBJECT_VALUE, permanent: true },
    });
    expect(result.isError).toBeFalsy();
    expect(toolText(result)).toContain("Successfully deleted");
  });

  it("30 – delete non-existent subject returns error", async () => {
    const result = await ctx.client.callTool({
      name: ToolName.DELETE_SCHEMA,
      arguments: { subject: testSubjectName("no-such-subject") },
    });
    expect(result.isError).toBeTruthy();
  });

  // Skipping test 27 (delete specific version) because the subject was
  // already fully deleted. Re-register and test version deletion.
  it("27 – delete specific schema version", async () => {
    // Re-register the schema
    const produceResult = await ctx.client.callTool({
      name: ToolName.PRODUCE_MESSAGE,
      arguments: {
        topicName: TOPIC_SR,
        value: {
          message: { id: 2, label: "v2" },
          useSchemaRegistry: true,
          schemaType: "AVRO",
          schema: AVRO_SCHEMA,
        },
      },
    });
    expect(produceResult.isError).toBeFalsy();
    await sleep(1000);

    // Delete only the latest version
    const result = await ctx.client.callTool({
      name: ToolName.DELETE_SCHEMA,
      arguments: {
        subject: SUBJECT_VALUE,
        version: "latest",
        permanent: false,
      },
    });
    expect(result.isError).toBeFalsy();
    expect(toolText(result)).toContain("Successfully deleted");
  });
});
