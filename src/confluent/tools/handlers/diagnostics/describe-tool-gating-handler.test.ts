import { CallToolResult } from "@src/confluent/schema.js";
import { READ_ONLY } from "@src/confluent/tools/base-tools.js";
import { ToolDisabledReason } from "@src/confluent/tools/connection-predicates.js";
import { DescribeToolGatingHandler } from "@src/confluent/tools/handlers/diagnostics/describe-tool-gating-handler.js";
import type { ToolGatingReport } from "@src/confluent/tools/tool-availability.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ToolHandlerRegistry } from "@src/confluent/tools/tool-registry.js";
import {
  KAFKA_CONN,
  bareRuntime,
  ccloudOAuthRuntime,
  runtimeWith,
} from "@tests/factories/runtime.js";
import { describe, expect, it } from "vitest";

function getText(result: CallToolResult): string {
  const item = result.content[0]!;
  if (item.type !== "text") throw new Error("expected text content");
  return item.text;
}

/** Escape regex metacharacters in a literal string so it can be embedded
 *  inside a `new RegExp(...)` pattern without partial-match surprises
 *  from `'.'` or `'('` inside enum string values. */
function escapeForRegex(literal: string): string {
  return literal.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function getReport(result: CallToolResult): ToolGatingReport {
  const meta = result._meta;
  if (meta === undefined) throw new Error("expected _meta on result");
  return meta as unknown as ToolGatingReport;
}

describe("describe-tool-gating-handler.ts", () => {
  describe("DescribeToolGatingHandler", () => {
    const handler = new DescribeToolGatingHandler(() =>
      ToolHandlerRegistry.allHandlers(),
    );

    describe("getToolConfig()", () => {
      it("should be a read-only tool named DESCRIBE_TOOL_GATING with no input fields", () => {
        const config = handler.getToolConfig();
        expect(config.name).toBe(ToolName.DESCRIBE_TOOL_GATING);
        expect(config.annotations).toBe(READ_ONLY);
        expect(config.inputSchema).toEqual({});
        expect(config.description.length).toBeGreaterThan(10);
      });
    });

    describe("handle()", () => {
      it("should report kafka-gated tools under MissingKafkaBlock when run against a bare runtime", async () => {
        const result = handler.handle(bareRuntime());
        const report = getReport(result);

        const kafkaGroup = report.disabled_groups.find(
          (g) => g.reason === ToolDisabledReason.MissingKafkaBlock,
        );
        expect(
          kafkaGroup,
          "expected a disabled_groups entry for MissingKafkaBlock against a bare runtime",
        ).toBeDefined();
        expect(kafkaGroup!.tools).toContain(ToolName.LIST_TOPICS);
        expect(kafkaGroup!.tools).toContain(ToolName.PRODUCE_MESSAGE);
        expect(report.disabled_count).toBeGreaterThan(0);
      });

      it("should not list alwaysEnabled tools (search-product-docs, get-product-doc-page, describe-tool-gating) under any disabled group", async () => {
        const result = handler.handle(bareRuntime());
        const report = getReport(result);

        const allDisabledTools = report.disabled_groups.flatMap((g) => g.tools);
        expect(allDisabledTools).not.toContain(ToolName.SEARCH_PRODUCT_DOCS);
        expect(allDisabledTools).not.toContain(ToolName.GET_PRODUCT_DOC_PAGE);
        expect(allDisabledTools).not.toContain(ToolName.DESCRIBE_TOOL_GATING);
      });

      it("should remove kafka tools from disabled_groups when the connection carries a kafka block", async () => {
        const result = handler.handle(runtimeWith(KAFKA_CONN));
        const report = getReport(result);

        const allDisabledTools = report.disabled_groups.flatMap((g) => g.tools);
        expect(allDisabledTools).not.toContain(ToolName.LIST_TOPICS);
        expect(allDisabledTools).not.toContain(ToolName.PRODUCE_MESSAGE);

        const flinkGroup = report.disabled_groups.find(
          (g) => g.reason === ToolDisabledReason.MissingFlinkBlock,
        );
        expect(flinkGroup).toBeDefined();
        expect(flinkGroup!.tools).toContain(ToolName.LIST_FLINK_STATEMENTS);
      });

      it("should report OAuthNoServiceBlocks against an OAuth-typed connection for tools that need a service block", async () => {
        const result = handler.handle(ccloudOAuthRuntime());
        const report = getReport(result);

        const oauthGroup = report.disabled_groups.find(
          (g) => g.reason === ToolDisabledReason.OAuthNoServiceBlocks,
        );
        expect(oauthGroup).toBeDefined();
        expect(oauthGroup!.tools).toContain(ToolName.LIST_FLINK_STATEMENTS);
      });

      it("should account for every registered tool in the enabled and disabled counts (no double-counting, no skips)", async () => {
        const result = handler.handle(bareRuntime());
        const report = getReport(result);

        const totalRegistered = Array.from(
          ToolHandlerRegistry.allHandlers(),
        ).length;
        expect(report.enabled_count + report.disabled_count).toBe(
          totalRegistered,
        );
        const flatDisabledCount = report.disabled_groups.reduce(
          (sum, g) => sum + g.tools.length,
          0,
        );
        expect(flatDisabledCount).toBe(report.disabled_count);
      });

      it("should render the disabled-count summary header with both totals", async () => {
        const text = getText(handler.handle(bareRuntime()));
        const totalRegistered = Array.from(
          ToolHandlerRegistry.allHandlers(),
        ).length;
        expect(text).toMatch(
          new RegExp(
            String.raw`^\d+ of ${totalRegistered} tools disabled for the following reasons:`,
          ),
        );
      });

      it("should render each disabled group as a header line plus indented '    - <tool>' bullets", async () => {
        const text = getText(handler.handle(bareRuntime()));
        // Pin the specific kafka group: header ends with `(<n>):` (no inline
        // tool list), and each tool lives on its own bullet line indented
        // four spaces. A future regression that reverts to the old
        // comma-joined form fails on the bullet expectation.
        expect(text).toMatch(
          new RegExp(
            String.raw`\n  ${escapeForRegex(ToolDisabledReason.MissingKafkaBlock)} \(\d+\):\n`,
          ),
        );
        expect(text).toContain("\n    - list-topics\n");
        expect(text).toContain("tools advertised via tools/list.");
      });

      it("should render a single 'all tools enabled' summary when nothing is disabled", async () => {
        // Build a no-tool registry-thunk so every tool is trivially absent
        // from the disabled set; the flat-summary branch fires.
        const empty = new DescribeToolGatingHandler(() => []);
        const text = getText(empty.handle(bareRuntime()));
        expect(text).toBe(
          "All 0 registered tools are advertised via tools/list.",
        );
      });
    });
  });
});
