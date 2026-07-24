import type { CallToolResult } from "@src/confluent/schema.js";
import { READ_ONLY, ToolCategory } from "@src/confluent/tools/base-tools.js";
import { ToolDisabledReason } from "@src/confluent/tools/connection-predicates.js";
import { ExplainDisabledToolsHandler } from "@src/confluent/tools/handlers/diagnostics/explain-disabled-tools-handler.js";
import type {
  ConnectionGatingSection,
  DisabledToolGroup,
  ToolGatingReport,
} from "@src/confluent/tools/tool-availability.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ToolHandlerRegistry } from "@src/confluent/tools/tool-registry.js";
import {
  FLINK_CONN,
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

function sectionFor(
  report: ToolGatingReport,
  connectionId: string,
): ConnectionGatingSection {
  const section = report.connections.find(
    (s) => s.connectionId === connectionId,
  );
  if (section === undefined) {
    throw new Error(`expected a section for connection '${connectionId}'`);
  }
  return section;
}

function groupByReason(
  section: ConnectionGatingSection,
  reason: ToolDisabledReason,
): DisabledToolGroup | undefined {
  return section.disabledGroups.find(
    (g) => "reason" in g && g.reason === reason,
  );
}

const totalRegistered = Array.from(ToolHandlerRegistry.allHandlers()).length;

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
      it("should report kafka-gated tools under MissingKafkaBlock in the lone connection's section against a bare runtime", () => {
        const report = getReport(handler.handle(bareRuntime(), undefined));

        const section = sectionFor(report, "default");
        const kafkaGroup = groupByReason(
          section,
          ToolDisabledReason.MissingKafkaBlock,
        );
        expect(
          kafkaGroup,
          "expected a MissingKafkaBlock bucket in the default section against a bare runtime",
        ).toBeDefined();
        expect(kafkaGroup!.tools).toContain(ToolName.LIST_TOPICS);
        expect(kafkaGroup!.tools).toContain(ToolName.PRODUCE_MESSAGE);
        expect(section.disabledCount).toBeGreaterThan(0);
      });

      it("should not list alwaysEnabled tools (search-product-docs, get-product-doc-page, explain-disabled-tools) in any section", () => {
        const report = getReport(handler.handle(bareRuntime(), undefined));

        const allSectionTools = report.connections.flatMap((s) =>
          s.disabledGroups.flatMap((g) => g.tools),
        );
        for (const independent of [
          ToolName.SEARCH_PRODUCT_DOCS,
          ToolName.GET_PRODUCT_DOC_PAGE,
          ToolName.EXPLAIN_DISABLED_TOOLS,
        ]) {
          expect(allSectionTools).not.toContain(independent);
        }
      });

      it("should drop kafka tools from the section and keep flink tools disabled when the connection carries a kafka block", () => {
        const report = getReport(
          handler.handle(runtimeWith(KAFKA_CONN), undefined),
        );

        const section = sectionFor(report, "default");
        const allDisabled = section.disabledGroups.flatMap((g) => g.tools);
        expect(allDisabled).not.toContain(ToolName.LIST_TOPICS);
        expect(allDisabled).not.toContain(ToolName.PRODUCE_MESSAGE);

        const flinkGroup = groupByReason(
          section,
          ToolDisabledReason.MissingFlinkBlock,
        );
        expect(flinkGroup).toBeDefined();
        expect(flinkGroup!.tools).toContain(ToolName.LIST_FLINK_STATEMENTS);
      });

      it("should report OAuthNoServiceBlocks in the OAuth connection's section for tools that need a service block", () => {
        const report = getReport(
          handler.handle(ccloudOAuthRuntime(), undefined),
        );

        const section = sectionFor(report, "default");
        const directOnlyGroup = groupByReason(
          section,
          ToolDisabledReason.OAuthNotDirectCapable,
        );
        expect(directOnlyGroup).toBeDefined();
        expect(directOnlyGroup!.tools).toContain(ToolName.CREATE_CONNECTOR);

        // Every block-gated tool family (Kafka, Flink, Schema Registry,
        // Connect, Catalog, Telemetry, Tableflow) is now OAuth-capable, so no
        // tool surfaces OAuthNoServiceBlocks under an OAuth connection.
        expect(
          groupByReason(section, ToolDisabledReason.OAuthNoServiceBlocks),
        ).toBeUndefined();
      });

      it("should split a tool across the per-connection sections of a flink+kafka pair of connections", () => {
        const report = getReport(
          handler.handle(
            runtimeWithConnections({
              "ccloud-flink": FLINK_CONN,
              "local-kafka": KAFKA_CONN,
            }),
            undefined,
          ),
        );

        // Sections come back lex-sorted by id.
        expect(report.connections.map((s) => s.connectionId)).toEqual([
          "ccloud-flink",
          "local-kafka",
        ]);

        // The flink-only connection lacks Kafka, so list-topics is disabled
        // there but absent from the kafka connection's section (enabled there).
        const flinkSection = sectionFor(report, "ccloud-flink");
        expect(
          groupByReason(flinkSection, ToolDisabledReason.MissingKafkaBlock)!
            .tools,
        ).toContain(ToolName.LIST_TOPICS);
        const kafkaSection = sectionFor(report, "local-kafka");
        expect(
          kafkaSection.disabledGroups.flatMap((g) => g.tools),
        ).not.toContain(ToolName.LIST_TOPICS);

        // ...and symmetrically, the kafka-only connection lacks Flink, so
        // list-flink-statements is disabled there but enabled on the flink one.
        expect(
          groupByReason(kafkaSection, ToolDisabledReason.MissingFlinkBlock)!
            .tools,
        ).toContain(ToolName.LIST_FLINK_STATEMENTS);
        expect(
          flinkSection.disabledGroups.flatMap((g) => g.tools),
        ).not.toContain(ToolName.LIST_FLINK_STATEMENTS);
      });

      it("should keep connection-independent tools enabled and report no sections on a zero-connection config", () => {
        const report = getReport(
          handler.handle(runtimeWithConnections({}), undefined),
        );

        expect(report.connections).toEqual([]);
        // The alwaysEnabled tools stay enabled with no connections at all;
        // every connection-dependent tool is dark.
        expect(report.enabledCount).toBeGreaterThan(0);
        expect(report.disabledCount).toBeGreaterThan(0);
        expect(report.enabledCount + report.disabledCount).toBe(
          totalRegistered,
        );
      });

      it("should account for every registered tool in the enabled and disabled counts (no double-counting, no skips)", () => {
        const report = getReport(handler.handle(bareRuntime(), undefined));
        expect(report.enabledCount + report.disabledCount).toBe(
          totalRegistered,
        );
      });

      it("should render a section header per connection on a flink+kafka pair", () => {
        const text = getText(
          handler.handle(
            runtimeWithConnections({
              "ccloud-flink": FLINK_CONN,
              "local-kafka": KAFKA_CONN,
            }),
            undefined,
          ),
        );

        expect(text).toContain("Per-connection tool gating (by reason):");
        expect(text).toContain("Connection 'ccloud-flink' —");
        expect(text).toContain("Connection 'local-kafka' —");
        // list-topics is disabled on the flink-only connection; its bullet
        // sits under that connection's MissingKafkaBlock bucket.
        expect(text).toContain("\n      - list-topics\n");
        expect(text).toContain("tools advertised via tools/list.");
      });

      it("should render a connection header, an indented reason bucket, and six-space tool bullets against a bare runtime", () => {
        const text = getText(handler.handle(bareRuntime(), undefined));
        expect(text).toContain("Connection 'default' —");
        // Bucket header is indented four spaces under the connection; tool
        // bullets sit six spaces in, one per line. A regression to a
        // comma-joined inline list fails the bullet expectation.
        expect(text).toMatch(
          new RegExp(
            String.raw`\n    ${escapeForRegex(ToolDisabledReason.MissingKafkaBlock)} \(\d+\):\n`,
          ),
        );
        expect(text).toContain("\n      - list-topics\n");
      });

      it("should render the dedicated no-connections summary on a zero-connection config", () => {
        const text = getText(
          handler.handle(runtimeWithConnections({}), undefined),
        );
        expect(text).toMatch(
          new RegExp(
            String.raw`^No connections are configured — \d+ of ${totalRegistered} tools are connection-gated and unavailable;`,
          ),
        );
      });

      it("should render a single 'all tools advertised' summary when nothing is disabled", () => {
        // A no-tool registry-thunk makes every tool trivially absent from the
        // disabled set; the all-advertised branch fires even though the runtime
        // has a connection.
        const empty = new ExplainDisabledToolsHandler(() => []);
        const text = getText(empty.handle(bareRuntime(), undefined));
        expect(text).toBe(
          "All 0 registered tools are advertised via tools/list.",
        );
      });

      it("should render the 'all tools advertised' summary on a zero-connection config when nothing is disabled", () => {
        // No connections AND no disabled tools (empty registry) takes the
        // all-advertised branch ahead of the no-connections summary — there is
        // genuinely nothing connection-gated to report.
        const empty = new ExplainDisabledToolsHandler(() => []);
        const text = getText(
          empty.handle(runtimeWithConnections({}), undefined),
        );
        expect(text).toBe(
          "All 0 registered tools are advertised via tools/list.",
        );
      });

      describe("operator allow/block-list", () => {
        // Allow only a flink tool: it stays predicate-disabled on a kafka-only
        // connection (a MissingFlinkBlock gap), while every other tool —
        // including list-topics, which the kafka block would otherwise enable —
        // is operator-blocked.
        const onlyFlinkAllowed: ReadonlySet<ToolName> = new Set([
          ToolName.LIST_FLINK_STATEMENTS,
        ]);

        it("should list an operator-blocked tool in operatorBlocked and in no connection section", () => {
          const report = getReport(
            handler.handle(
              runtimeWith(KAFKA_CONN, "default", undefined, onlyFlinkAllowed),
              undefined,
            ),
          );

          expect(report.operatorBlocked).toContain(ToolName.LIST_TOPICS);
          const allSectionTools = report.connections.flatMap((s) =>
            s.disabledGroups.flatMap((g) => g.tools),
          );
          expect(allSectionTools).not.toContain(ToolName.LIST_TOPICS);
        });

        it("should render the operator-block as a server-wide block above the per-connection sections", () => {
          const text = getText(
            handler.handle(
              runtimeWith(KAFKA_CONN, "default", undefined, onlyFlinkAllowed),
              undefined,
            ),
          );

          const blockHeader = `${ToolDisabledReason.OperatorBlocked} (`;
          expect(text).toContain(blockHeader);
          // Operator-blocked bullets sit two spaces in (top-level), distinct
          // from the six-space per-connection section bullets.
          expect(text).toContain("\n  - list-topics");
          // The server-wide block precedes the per-connection heading.
          expect(text.indexOf(blockHeader)).toBeLessThan(
            text.indexOf("Per-connection tool gating (by reason):"),
          );
        });

        it("should surface the operator-block instead of the all-advertised summary when no connection has a predicate gap", () => {
          // Allow only a connection-independent tool: every connection-dependent
          // tool is operator-blocked, so no section carries a predicate gap. The
          // report must still report the blocked tools, never claim all advertised.
          const text = getText(
            handler.handle(
              runtimeWith(
                KAFKA_CONN,
                "default",
                undefined,
                new Set([ToolName.SEARCH_PRODUCT_DOCS]),
              ),
              undefined,
            ),
          );

          expect(text).toContain(`${ToolDisabledReason.OperatorBlocked} (`);
          expect(text).toContain("\n  - list-topics");
          expect(text).not.toContain("registered tools are advertised");
        });

        it("should exclude operator-blocked tools from per-connection section denominators", () => {
          // Allow only create-topics (kafka tool) and list-flink-statements
          // (flink tool), operator-blocking all others. On a kafka-only
          // connection, create-topics is enabled and list-flink-statements is
          // disabled. The per-connection header should say "1 of 2" (not "1 of
          // ${totalRegistered}"), since only 2 tools survive the operator filter
          // to be connection-routable.
          const allowTwoTools: ReadonlySet<ToolName> = new Set([
            ToolName.CREATE_TOPICS,
            ToolName.LIST_FLINK_STATEMENTS,
          ]);

          const text = getText(
            handler.handle(
              runtimeWith(KAFKA_CONN, "default", undefined, allowTwoTools),
              undefined,
            ),
          );

          // Most tools are in the operator block (totalRegistered - 2).
          const operatorBlockedCount = totalRegistered - 2;
          expect(text).toContain(
            `${ToolDisabledReason.OperatorBlocked} (${operatorBlockedCount}):`,
          );
          // Per-connection section header: 1 disabled out of 2 connection-routable
          // tools (create-topics + list-flink-statements), not totalRegistered.
          expect(text).toContain(
            "Connection 'default' — 1 of 2 tools disabled:",
          );
        });
      });

      describe('group_by: "category"', () => {
        it('should bucket disabled tools by handler.category within each section and tag the report with groupBy="category"', () => {
          const report = getReport(
            handler.handle(bareRuntime(), { group_by: "category" }),
          );

          expect(report.groupBy).toBe("category");

          // Bare runtime → every block-gated tool is disabled. Kafka tools
          // bucket under ToolCategory.Kafka regardless of the specific
          // ToolDisabledReason they each emit.
          const section = sectionFor(report, "default");
          const kafkaGroup = section.disabledGroups.find(
            (g) => "category" in g && g.category === ToolCategory.Kafka,
          );
          expect(
            kafkaGroup,
            "expected a ToolCategory.Kafka bucket in the default section",
          ).toBeDefined();
          expect(kafkaGroup!.tools).toContain(ToolName.LIST_TOPICS);
          expect(kafkaGroup!.tools).toContain(ToolName.PRODUCE_MESSAGE);
        });

        it("should render the heading with '(by category)' under group_by='category'", () => {
          const text = getText(
            handler.handle(bareRuntime(), { group_by: "category" }),
          );
          expect(text).toContain("Per-connection tool gating (by category):");
          // A ToolCategory.Kafka bucket renders its kebab-case enum value as
          // the bucket header — pins the renderer reading from
          // `disabledToolGroupKey` rather than a legacy `group.reason`.
          expect(text).toMatch(
            new RegExp(String.raw`\n    ${ToolCategory.Kafka} \(\d+\):\n`),
          );
        });

        it("should render category buckets lex-sorted by kebab-case enum value within the section", () => {
          // Belt-and-suspenders against a regression that bypasses the
          // localeCompare in tool-availability.ts and renders categories in
          // (e.g.) handler-iteration order. Search for the four-space bucket
          // header prefix; tool bullets use a six-space `"      - "` prefix so
          // they won't collide.
          const text = getText(
            handler.handle(bareRuntime(), { group_by: "category" }),
          );
          const billingAt = text.indexOf("    billing (");
          const kafkaAt = text.indexOf("    kafka (");
          const tableflowAt = text.indexOf("    tableflow (");
          expect(billingAt, "billing header not found").toBeGreaterThan(-1);
          expect(kafkaAt, "kafka header not found").toBeGreaterThan(-1);
          expect(tableflowAt, "tableflow header not found").toBeGreaterThan(-1);
          expect(billingAt).toBeLessThan(kafkaAt);
          expect(kafkaAt).toBeLessThan(tableflowAt);
        });

        it("should treat group_by as optional and default to 'reason' when absent", () => {
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
          expect(issues[0]).toMatchObject({
            path: ["group_by"],
            code: "invalid_value",
          });
        });
      });
    });
  });
});
