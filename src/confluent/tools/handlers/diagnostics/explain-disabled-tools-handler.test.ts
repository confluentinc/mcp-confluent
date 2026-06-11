import { CallToolResult } from "@src/confluent/schema.js";
import { READ_ONLY, ToolCategory } from "@src/confluent/tools/base-tools.js";
import { ToolDisabledReason } from "@src/confluent/tools/connection-predicates.js";
import { ExplainDisabledToolsHandler } from "@src/confluent/tools/handlers/diagnostics/explain-disabled-tools-handler.js";
import type { ToolGatingReport } from "@src/confluent/tools/tool-availability.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ToolHandlerRegistry } from "@src/confluent/tools/tool-registry.js";
import {
  KAFKA_CONN,
  bareRuntime,
  ccloudOAuthRuntime,
  runtimeWith,
  runtimeWithConnections,
} from "@tests/factories/runtime.js";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

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

describe("explain-disabled-tools-handler.ts", () => {
  describe("ExplainDisabledToolsHandler", () => {
    const handler = new ExplainDisabledToolsHandler(() =>
      ToolHandlerRegistry.allHandlers(),
    );

    describe("getToolConfig()", () => {
      it("should be a read-only tool named EXPLAIN_DISABLED_TOOLS with a group_by input field", () => {
        const config = handler.getToolConfig();
        expect(config.name).toBe(ToolName.EXPLAIN_DISABLED_TOOLS);
        expect(config.annotations).toBe(READ_ONLY);
        expect(config.description.length).toBeGreaterThan(10);
        // Schema exposes a single optional `group_by` enum.
        expect(Object.keys(config.inputSchema)).toEqual(["group_by"]);
      });
    });

    describe("handle()", () => {
      it("should report kafka-gated tools under MissingKafkaBlock when run against a bare runtime", async () => {
        const result = handler.handle(bareRuntime(), undefined);
        const report = getReport(result);

        const kafkaGroup = report.disabledGroups.find(
          (g) =>
            "reason" in g && g.reason === ToolDisabledReason.MissingKafkaBlock,
        );
        expect(
          kafkaGroup,
          "expected a disabledGroups entry for MissingKafkaBlock against a bare runtime",
        ).toBeDefined();
        expect(kafkaGroup!.tools).toContain(ToolName.LIST_TOPICS);
        expect(kafkaGroup!.tools).toContain(ToolName.PRODUCE_MESSAGE);
        expect(report.disabledCount).toBeGreaterThan(0);
      });

      it("should not list alwaysEnabled tools (search-product-docs, get-product-doc-page, explain-disabled-tools) under any disabled group", async () => {
        const result = handler.handle(bareRuntime(), undefined);
        const report = getReport(result);

        const allDisabledTools = report.disabledGroups.flatMap((g) => g.tools);
        expect(allDisabledTools).not.toContain(ToolName.SEARCH_PRODUCT_DOCS);
        expect(allDisabledTools).not.toContain(ToolName.GET_PRODUCT_DOC_PAGE);
        expect(allDisabledTools).not.toContain(ToolName.EXPLAIN_DISABLED_TOOLS);
      });

      it("should remove kafka tools from disabledGroups when the connection carries a kafka block", async () => {
        const result = handler.handle(runtimeWith(KAFKA_CONN), undefined);
        const report = getReport(result);

        const allDisabledTools = report.disabledGroups.flatMap((g) => g.tools);
        expect(allDisabledTools).not.toContain(ToolName.LIST_TOPICS);
        expect(allDisabledTools).not.toContain(ToolName.PRODUCE_MESSAGE);

        const flinkGroup = report.disabledGroups.find(
          (g) =>
            "reason" in g && g.reason === ToolDisabledReason.MissingFlinkBlock,
        );
        expect(flinkGroup).toBeDefined();
        expect(flinkGroup!.tools).toContain(ToolName.LIST_FLINK_STATEMENTS);
      });

      it("should report OAuthNoServiceBlocks against an OAuth-typed connection for tools that need a service block", async () => {
        const result = handler.handle(ccloudOAuthRuntime(), undefined);
        const report = getReport(result);

        const oauthGroup = report.disabledGroups.find(
          (g) =>
            "reason" in g &&
            g.reason === ToolDisabledReason.OAuthNoServiceBlocks,
        );
        expect(oauthGroup).toBeDefined();
        expect(oauthGroup!.tools).toContain(ToolName.LIST_FLINK_STATEMENTS);
      });

      it("should keep connection-independent tools enabled and bucket every other tool under NoConnectionsConfigured on a zero-connection config", async () => {
        const result = handler.handle(runtimeWithConnections({}), undefined);
        const report = getReport(result);

        const allDisabledTools = report.disabledGroups.flatMap((g) => g.tools);
        // The alwaysEnabled tools stay enabled with no connections at all.
        expect(allDisabledTools).not.toContain(ToolName.SEARCH_PRODUCT_DOCS);
        expect(allDisabledTools).not.toContain(ToolName.EXPLAIN_DISABLED_TOOLS);

        // Every connection-dependent tool collapses into a single group: there
        // is no connection to attribute a per-service reason to.
        expect(report.disabledGroups).toHaveLength(1);
        expect(report.disabledGroups[0]).toHaveProperty(
          "reason",
          ToolDisabledReason.NoConnectionsConfigured,
        );
        expect(report.disabledGroups[0]!.tools).toContain(ToolName.LIST_TOPICS);
        expect(report.enabledCount + report.disabledCount).toBe(
          Array.from(ToolHandlerRegistry.allHandlers()).length,
        );
      });

      it("should account for every registered tool in the enabled and disabled counts (no double-counting, no skips)", async () => {
        const result = handler.handle(bareRuntime(), undefined);
        const report = getReport(result);

        const totalRegistered = Array.from(
          ToolHandlerRegistry.allHandlers(),
        ).length;
        expect(report.enabledCount + report.disabledCount).toBe(
          totalRegistered,
        );
        const flatDisabledCount = report.disabledGroups.reduce(
          (sum, g) => sum + g.tools.length,
          0,
        );
        expect(flatDisabledCount).toBe(report.disabledCount);
      });

      it("should render the disabled-count summary header with both totals", async () => {
        const text = getText(handler.handle(bareRuntime(), undefined));
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
        const text = getText(handler.handle(bareRuntime(), undefined));
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
        const empty = new ExplainDisabledToolsHandler(() => []);
        const text = getText(empty.handle(bareRuntime(), undefined));
        expect(text).toBe(
          "All 0 registered tools are advertised via tools/list.",
        );
      });

      describe('group_by: "category"', () => {
        it('should bucket disabled tools by handler.category and tag the report with groupBy="category"', async () => {
          const result = handler.handle(bareRuntime(), {
            group_by: "category",
          });
          const report = getReport(result);

          expect(report.groupBy).toBe("category");

          // Bare runtime → every block-gated tool is disabled. Kafka tools
          // bucket under ToolCategory.Kafka regardless of the specific
          // ToolDisabledReason they each emit.
          const kafkaGroup = report.disabledGroups.find(
            (g) => "category" in g && g.category === ToolCategory.Kafka,
          );
          expect(
            kafkaGroup,
            "expected a ToolCategory.Kafka bucket against a bare runtime",
          ).toBeDefined();
          expect(kafkaGroup!.tools).toContain(ToolName.LIST_TOPICS);
          expect(kafkaGroup!.tools).toContain(ToolName.PRODUCE_MESSAGE);
        });

        it("should render the heading with 'across the following categories' under group_by='category'", async () => {
          const text = getText(
            handler.handle(bareRuntime(), { group_by: "category" }),
          );
          const totalRegistered = Array.from(
            ToolHandlerRegistry.allHandlers(),
          ).length;
          expect(text).toMatch(
            new RegExp(
              String.raw`^\d+ of ${totalRegistered} tools disabled across the following categories:`,
            ),
          );
          // A ToolCategory.Kafka bucket renders its kebab-case enum value as
          // the group header — pins the renderer reading from
          // `disabledToolGroupKey` rather than the legacy `group.reason`.
          expect(text).toMatch(
            new RegExp(String.raw`\n  ${ToolCategory.Kafka} \(\d+\):\n`),
          );
        });

        it("should render category sections lex-sorted by kebab-case enum value", () => {
          // Belt-and-suspenders against a regression that bypasses the
          // localeCompare in tool-availability.ts and renders categories
          // in (e.g.) handler-iteration or enum-declaration order. The
          // data-shape test in tool-availability.test.ts pins the sorted
          // disabledGroups; this one pins that the renderer doesn't
          // re-order between data and text. Search for the `"  <name> ("`
          // header prefix (two-space indent + name + count-paren) — that's
          // unique to bucket headers and won't collide with tool-name
          // bullets, which use a four-space `"    - "` prefix.
          const text = getText(
            handler.handle(bareRuntime(), { group_by: "category" }),
          );
          const billingAt = text.indexOf("  billing (");
          const kafkaAt = text.indexOf("  kafka (");
          const tableflowAt = text.indexOf("  tableflow (");
          expect(billingAt, "billing header not found").toBeGreaterThan(-1);
          expect(kafkaAt, "kafka header not found").toBeGreaterThan(-1);
          expect(tableflowAt, "tableflow header not found").toBeGreaterThan(-1);
          expect(billingAt).toBeLessThan(kafkaAt);
          expect(kafkaAt).toBeLessThan(tableflowAt);
        });

        it("should treat group_by as optional and default to 'reason' when absent", async () => {
          // Schema default makes an undefined arg equivalent to passing
          // group_by="reason" — pins the back-compat path so existing
          // callers (no args) see no behaviour change.
          const withDefault = getReport(
            handler.handle(bareRuntime(), undefined),
          );
          const explicit = getReport(
            handler.handle(bareRuntime(), { group_by: "reason" }),
          );
          expect(withDefault.groupBy).toBe("reason");
          expect(explicit.groupBy).toBe("reason");
        });

        it("should reject group_by values outside the enum with a Zod issue pinned to the group_by field", () => {
          let caught: unknown;
          try {
            handler.handle(bareRuntime(), { group_by: "color" });
          } catch (err) {
            caught = err;
          }
          expect(caught).toBeInstanceOf(ZodError);
          const issues = (caught as ZodError).issues;
          expect(issues).toHaveLength(1);
          // Path pins the offending field; code pins the validator class
          // (Zod v4 collapses enum/literal mismatches under `invalid_value`).
          // A future regression that loosened the schema in a different
          // place — say, dropping the enum constraint entirely — would
          // fail either by not throwing at all or by emitting a different
          // path, both of which this assertion catches.
          expect(issues[0]).toMatchObject({
            path: ["group_by"],
            code: "invalid_value",
          });
        });
      });
    });
  });
});
