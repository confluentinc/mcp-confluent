/**
 * Integration tests for Flink SQL tools (tests 44-53 from RELEASE-VERIFICATION.md).
 *
 * Covers catalog browsing (catalogs, databases, tables, describe), statement
 * lifecycle (create, read, list, exceptions, health, delete).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  type IntegrationContext,
  requireEnvVars,
  setupIntegration,
  teardownIntegration,
  toolText,
} from "./setup.js";

// ── All Flink tools used in this suite ─────────────────────────────────────
const ALL_TOOLS: ToolName[] = [
  ToolName.LIST_FLINK_CATALOGS,
  ToolName.LIST_FLINK_DATABASES,
  ToolName.LIST_FLINK_TABLES,
  ToolName.DESCRIBE_FLINK_TABLE,
  ToolName.CREATE_FLINK_STATEMENT,
  ToolName.READ_FLINK_STATEMENT,
  ToolName.LIST_FLINK_STATEMENTS,
  ToolName.GET_FLINK_STATEMENT_EXCEPTIONS,
  ToolName.CHECK_FLINK_STATEMENT_HEALTH,
  ToolName.DELETE_FLINK_STATEMENTS,
];

// ── Helpers ────────────────────────────────────────────────────────────────

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// Statement name must match [a-z0-9]([-a-z0-9]*[a-z0-9])?
const STATEMENT_NAME = `inttest-${Date.now().toString(36)}`;

// ── Suite ──────────────────────────────────────────────────────────────────

describe("Flink SQL tools", () => {
  let ctx: IntegrationContext;

  // Common Flink params resolved from env vars, passed explicitly to tools
  // because the handlers use getEnsuredParam() which checks tool args first.
  let flinkParams: {
    organizationId: string;
    environmentId: string;
    computePoolId: string;
  };

  beforeAll(async () => {
    requireEnvVars(
      "FLINK_API_KEY",
      "FLINK_API_SECRET",
      "FLINK_ORG_ID",
      "FLINK_ENV_ID",
      "FLINK_COMPUTE_POOL_ID",
      "FLINK_REST_ENDPOINT",
      "FLINK_ENV_NAME",
      "FLINK_DATABASE_NAME",
    );
    flinkParams = {
      organizationId: process.env.FLINK_ORG_ID!,
      environmentId: process.env.FLINK_ENV_ID!,
      computePoolId: process.env.FLINK_COMPUTE_POOL_ID!,
    };
    ctx = await setupIntegration(ALL_TOOLS);
  }, 30_000);

  afterAll(async () => {
    // Best-effort cleanup: delete the test statement
    if (ctx) {
      try {
        await ctx.client.callTool({
          name: ToolName.DELETE_FLINK_STATEMENTS,
          arguments: { statementName: STATEMENT_NAME, ...flinkParams },
        });
      } catch {
        // ignore
      }
      await teardownIntegration(ctx);
    }
  }, 30_000);

  // ──────────────────────────────────────────────────────────────────────
  // 6.1 Catalog browsing
  // ──────────────────────────────────────────────────────────────────────

  describe("catalog browsing", () => {
    let firstTableName: string;

    it("44 – list-flink-catalogs returns available catalogs", async () => {
      const result = await ctx.client.callTool({
        name: ToolName.LIST_FLINK_CATALOGS,
        arguments: { ...flinkParams },
      });
      expect(result.isError).toBeFalsy();
      const text = toolText(result);
      expect(text).toBeTruthy();
    });

    it("45 – list-flink-databases returns databases", async () => {
      const result = await ctx.client.callTool({
        name: ToolName.LIST_FLINK_DATABASES,
        arguments: { ...flinkParams },
      });
      expect(result.isError).toBeFalsy();
      const text = toolText(result);
      expect(text).toBeTruthy();
    });

    it("46 – list-flink-tables returns tables", async () => {
      const result = await ctx.client.callTool({
        name: ToolName.LIST_FLINK_TABLES,
        arguments: { ...flinkParams },
      });
      expect(result.isError).toBeFalsy();
      const text = toolText(result);
      expect(text).toBeTruthy();

      // The response is JSON array with TABLE_NAME fields, e.g.:
      // [{"TABLE_CATALOG":"...","TABLE_SCHEMA":"...","TABLE_NAME":"my-topic","TABLE_TYPE":"..."}]
      const tableNameMatch = text.match(/"TABLE_NAME"\s*:\s*"([^"]+)"/);
      if (tableNameMatch?.[1]) {
        firstTableName = tableNameMatch[1];
      }
    });

    it("47 – describe-flink-table returns column schema", async () => {
      if (!firstTableName) {
        console.warn(
          "Skipping test 47: no table name found from list-flink-tables",
        );
        return;
      }

      const result = await ctx.client.callTool({
        name: ToolName.DESCRIBE_FLINK_TABLE,
        arguments: { tableName: firstTableName, ...flinkParams },
      });
      expect(result.isError).toBeFalsy();
      const text = toolText(result);
      expect(text).toBeTruthy();
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // 6.2 Statement lifecycle
  // ──────────────────────────────────────────────────────────────────────

  describe("statement lifecycle", () => {
    it("48 – create-flink-statement creates a statement", async () => {
      const result = await ctx.client.callTool({
        name: ToolName.CREATE_FLINK_STATEMENT,
        arguments: {
          statement: "SELECT 1",
          statementName: STATEMENT_NAME,
          catalogName: process.env.FLINK_ENV_NAME!,
          databaseName: process.env.FLINK_DATABASE_NAME!,
          ...flinkParams,
        },
      });
      expect(result.isError).toBeFalsy();
      const text = toolText(result);
      expect(text).toBeTruthy();
    });

    it("49 – read-flink-statement returns result", async () => {
      // Allow time for statement to become ready
      await sleep(5000);

      const result = await ctx.client.callTool({
        name: ToolName.READ_FLINK_STATEMENT,
        arguments: {
          statementName: STATEMENT_NAME,
          organizationId: flinkParams.organizationId,
          environmentId: flinkParams.environmentId,
          timeoutInMilliseconds: 30000,
        },
      });
      expect(result.isError).toBeFalsy();
      const text = toolText(result);
      expect(text).toBeTruthy();
    });

    it("50 – list-flink-statements shows the created statement", async () => {
      const result = await ctx.client.callTool({
        name: ToolName.LIST_FLINK_STATEMENTS,
        arguments: { ...flinkParams },
      });
      expect(result.isError).toBeFalsy();
      const text = toolText(result);
      expect(text).toContain(STATEMENT_NAME);
    });

    it("51 – get-flink-statement-exceptions returns empty or exception list", async () => {
      const result = await ctx.client.callTool({
        name: ToolName.GET_FLINK_STATEMENT_EXCEPTIONS,
        arguments: {
          statementName: STATEMENT_NAME,
          organizationId: flinkParams.organizationId,
          environmentId: flinkParams.environmentId,
        },
      });
      expect(result.isError).toBeFalsy();
      const text = toolText(result);
      expect(text).toBeTruthy();
    });

    it("52 – check-flink-statement-health returns health status", async () => {
      const result = await ctx.client.callTool({
        name: ToolName.CHECK_FLINK_STATEMENT_HEALTH,
        arguments: {
          statementName: STATEMENT_NAME,
          organizationId: flinkParams.organizationId,
          environmentId: flinkParams.environmentId,
        },
      });
      expect(result.isError).toBeFalsy();
      const text = toolText(result);
      expect(text).toBeTruthy();
    });

    it("53 – delete-flink-statements deletes the statement", async () => {
      const result = await ctx.client.callTool({
        name: ToolName.DELETE_FLINK_STATEMENTS,
        arguments: {
          statementName: STATEMENT_NAME,
          organizationId: flinkParams.organizationId,
          environmentId: flinkParams.environmentId,
        },
      });
      expect(result.isError).toBeFalsy();
    });
  });
});
