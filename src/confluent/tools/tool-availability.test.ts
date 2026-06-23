import {
  CREATE_UPDATE,
  ToolCategory,
  ToolHandler,
} from "@src/confluent/tools/base-tools.js";
import {
  ConnectionPredicate,
  ToolDisabledReason,
  alwaysEnabled,
  hasKafka,
} from "@src/confluent/tools/connection-predicates.js";
import {
  buildToolGatingReport,
  disabledToolGroupKey,
  groupDisabledToolsByReason,
} from "@src/confluent/tools/tool-availability.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  KAFKA_CONN,
  bareRuntime,
  runtimeWith,
  runtimeWithConnections,
} from "@tests/factories/runtime.js";
import { StubHandler } from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

function stubWithPredicate(
  predicate: ConnectionPredicate,
  category: ToolCategory = ToolCategory.Kafka,
): ToolHandler {
  const handler = new StubHandler({ category });
  // Override the readonly predicate via type assertion for test composition.
  (handler as unknown as { predicate: ConnectionPredicate }).predicate =
    predicate;
  return handler;
}

const disabledForKafka: ConnectionPredicate = () => ({
  enabled: false,
  reason: ToolDisabledReason.MissingKafkaBlock,
});

const disabledForFlink: ConnectionPredicate = () => ({
  enabled: false,
  reason: ToolDisabledReason.MissingFlinkBlock,
});

describe("tool-availability.ts", () => {
  describe("groupDisabledToolsByReason()", () => {
    it("should return an empty array when no tools are passed", () => {
      expect(groupDisabledToolsByReason([], bareRuntime())).toEqual([]);
    });

    it("should return an empty array when every tool is enabled on every connection", () => {
      const handler = stubWithPredicate(alwaysEnabled);
      expect(
        groupDisabledToolsByReason(
          [[ToolName.LIST_TOPICS, handler]],
          runtimeWith(KAFKA_CONN),
        ),
      ).toEqual([]);
    });

    it("should produce one group per (connectionId, reason) when one tool is disabled", () => {
      const handler = stubWithPredicate(disabledForKafka);
      const groups = groupDisabledToolsByReason(
        [[ToolName.LIST_TOPICS, handler]],
        runtimeWith({ schema_registry: { endpoint: "http://sr" } }),
      );
      expect(groups).toEqual([
        {
          connectionId: "default",
          reason: ToolDisabledReason.MissingKafkaBlock,
          toolNames: [ToolName.LIST_TOPICS],
        },
      ]);
    });

    it("should collapse multiple tools failing for the same (connectionId, reason) into one group", () => {
      const handlerA = stubWithPredicate(disabledForKafka);
      const handlerB = stubWithPredicate(disabledForKafka);
      const groups = groupDisabledToolsByReason(
        [
          [ToolName.LIST_TOPICS, handlerA],
          [ToolName.CREATE_TOPICS, handlerB],
        ],
        runtimeWith({ schema_registry: { endpoint: "http://sr" } }),
      );
      expect(groups).toEqual([
        {
          connectionId: "default",
          reason: ToolDisabledReason.MissingKafkaBlock,
          toolNames: [ToolName.LIST_TOPICS, ToolName.CREATE_TOPICS],
        },
      ]);
    });

    it("should split into separate groups when tools fail with different reasons", () => {
      const kafkaTool = stubWithPredicate(disabledForKafka);
      const flinkTool = stubWithPredicate(disabledForFlink);
      const groups = groupDisabledToolsByReason(
        [
          [ToolName.LIST_TOPICS, kafkaTool],
          [ToolName.LIST_FLINK_STATEMENTS, flinkTool],
        ],
        runtimeWith({ schema_registry: { endpoint: "http://sr" } }),
      );
      expect(groups).toEqual([
        {
          connectionId: "default",
          reason: ToolDisabledReason.MissingKafkaBlock,
          toolNames: [ToolName.LIST_TOPICS],
        },
        {
          connectionId: "default",
          reason: ToolDisabledReason.MissingFlinkBlock,
          toolNames: [ToolName.LIST_FLINK_STATEMENTS],
        },
      ]);
    });

    it("should omit tools that are enabled on at least one connection (only fully-disabled tools group)", () => {
      const handler = stubWithPredicate(hasKafka);
      const runtime = runtimeWithConnections({
        default: KAFKA_CONN,
        other: { schema_registry: { endpoint: "http://sr" } },
      });
      expect(
        groupDisabledToolsByReason([[ToolName.LIST_TOPICS, handler]], runtime),
      ).toEqual([]);
    });

    it("should bucket a mutating tool under ReadOnlyConnection when its sole connection is read_only", () => {
      // hasKafka passes on the read_only connection, but the read-only overlay
      // disables the mutating (CREATE_UPDATE) tool — so it surfaces in the log
      // grouping under the read-only reason, not a missing-block one.
      const mutatingTool = new StubHandler({
        predicate: hasKafka,
        annotations: CREATE_UPDATE,
      });
      const groups = groupDisabledToolsByReason(
        [[ToolName.CREATE_TOPICS, mutatingTool]],
        runtimeWith({ read_only: true, ...KAFKA_CONN }),
      );
      expect(groups).toEqual([
        {
          connectionId: "default",
          reason: ToolDisabledReason.ReadOnlyConnection,
          toolNames: [ToolName.CREATE_TOPICS],
        },
      ]);
    });

    it("should order groups lexicographically by connectionId, regardless of insertion order", () => {
      // `zeta` is inserted first; `alpha` is appended after. Lexicographic
      // ordering puts `alpha` first. Pins the helper's ordering against JS
      // plain-object key-iteration quirks — integer-like keys get
      // reordered numerically, and `Record<string, …>` is not a portable
      // insertion-order container — so deterministic log output cannot
      // rely on declaration order.
      const kafkaTool = stubWithPredicate(disabledForKafka);
      const flinkTool = stubWithPredicate(disabledForFlink);
      const runtime = runtimeWithConnections({
        zeta: {},
        alpha: { schema_registry: { endpoint: "http://sr-alpha" } },
      });

      const groups = groupDisabledToolsByReason(
        [
          [ToolName.LIST_TOPICS, kafkaTool],
          [ToolName.LIST_FLINK_STATEMENTS, flinkTool],
        ],
        runtime,
      );

      expect(groups.map((g) => [g.connectionId, g.reason] as const)).toEqual([
        ["alpha", ToolDisabledReason.MissingKafkaBlock],
        ["alpha", ToolDisabledReason.MissingFlinkBlock],
        ["zeta", ToolDisabledReason.MissingKafkaBlock],
        ["zeta", ToolDisabledReason.MissingFlinkBlock],
      ]);
    });
  });

  describe("buildToolGatingReport()", () => {
    it("should emit one empty section per configured connection with zero counts when no tools are passed", () => {
      const report = buildToolGatingReport([], runtimeWith({}, "default"));
      expect(report).toEqual({
        groupBy: "reason",
        operatorBlocked: [],
        connections: [
          {
            connectionId: "default",
            disabledGroups: [],
            enabledCount: 0,
            disabledCount: 0,
          },
        ],
        enabledCount: 0,
        disabledCount: 0,
      });
    });

    it("should count a connection-independent tool as enabled and place it in no section bucket or delta", () => {
      const handler = stubWithPredicate(alwaysEnabled);
      const report = buildToolGatingReport(
        [[ToolName.SEARCH_PRODUCT_DOCS, handler]],
        runtimeWith(KAFKA_CONN),
      );
      expect(report).toEqual({
        groupBy: "reason",
        operatorBlocked: [],
        connections: [
          {
            connectionId: "default",
            disabledGroups: [],
            enabledCount: 1,
            disabledCount: 0,
          },
        ],
        enabledCount: 1,
        disabledCount: 0,
      });
    });

    it("should bucket fully-disabled tools within the connection's section, sorted lex by reason", () => {
      const kafkaTool = stubWithPredicate(disabledForKafka);
      const otherKafkaTool = stubWithPredicate(disabledForKafka);
      const flinkTool = stubWithPredicate(disabledForFlink);
      const report = buildToolGatingReport(
        [
          [ToolName.LIST_TOPICS, kafkaTool],
          [ToolName.CREATE_TOPICS, otherKafkaTool],
          [ToolName.LIST_FLINK_STATEMENTS, flinkTool],
        ],
        runtimeWith({}, "default"),
      );
      expect(report).toEqual({
        groupBy: "reason",
        operatorBlocked: [],
        connections: [
          {
            connectionId: "default",
            disabledGroups: [
              {
                reason: ToolDisabledReason.MissingFlinkBlock,
                tools: [ToolName.LIST_FLINK_STATEMENTS],
              },
              {
                reason: ToolDisabledReason.MissingKafkaBlock,
                tools: [ToolName.LIST_TOPICS, ToolName.CREATE_TOPICS],
              },
            ],
            enabledCount: 0,
            disabledCount: 3,
          },
        ],
        enabledCount: 0,
        disabledCount: 3,
      });
    });

    it("should split a mixed tool across per-connection sections, disabled on the connection that lacks its block", () => {
      // The crux of #559: a tool enabled on one connection and disabled on
      // another no longer flattens to "enabled". It is absent from the
      // satisfied connection's section (so enabled there) and bucketed in the
      // other's section under the reason that connection falls short — the
      // cross-connection asymmetry is readable by comparing the two sections.
      const handler = stubWithPredicate(hasKafka);
      const runtime = runtimeWithConnections({
        "with-kafka": KAFKA_CONN,
        "without-kafka": {},
      });

      const report = buildToolGatingReport(
        [[ToolName.LIST_TOPICS, handler]],
        runtime,
      );

      expect(report).toEqual({
        groupBy: "reason",
        operatorBlocked: [],
        connections: [
          {
            connectionId: "with-kafka",
            disabledGroups: [],
            enabledCount: 1,
            disabledCount: 0,
          },
          {
            connectionId: "without-kafka",
            disabledGroups: [
              {
                reason: ToolDisabledReason.MissingKafkaBlock,
                tools: [ToolName.LIST_TOPICS],
              },
            ],
            enabledCount: 0,
            disabledCount: 1,
          },
        ],
        enabledCount: 1,
        disabledCount: 0,
      });
    });

    it("should list a tool dark on every connection in each connection's section and count it once", () => {
      const handler = stubWithPredicate(disabledForKafka);
      const runtime = runtimeWithConnections({ alpha: {}, bravo: {} });

      const report = buildToolGatingReport(
        [[ToolName.LIST_TOPICS, handler]],
        runtime,
      );

      expect(report).toEqual({
        groupBy: "reason",
        operatorBlocked: [],
        connections: [
          {
            connectionId: "alpha",
            disabledGroups: [
              {
                reason: ToolDisabledReason.MissingKafkaBlock,
                tools: [ToolName.LIST_TOPICS],
              },
            ],
            enabledCount: 0,
            disabledCount: 1,
          },
          {
            connectionId: "bravo",
            disabledGroups: [
              {
                reason: ToolDisabledReason.MissingKafkaBlock,
                tools: [ToolName.LIST_TOPICS],
              },
            ],
            enabledCount: 0,
            disabledCount: 1,
          },
        ],
        enabledCount: 0,
        disabledCount: 1,
      });
    });

    it("should order connection sections lex by connectionId, regardless of insertion order", () => {
      const handler = stubWithPredicate(disabledForKafka);
      const runtime = runtimeWithConnections({ zeta: {}, alpha: {} });

      const report = buildToolGatingReport(
        [[ToolName.LIST_TOPICS, handler]],
        runtime,
      );

      expect(report.connections.map((c) => c.connectionId)).toEqual([
        "alpha",
        "zeta",
      ]);
    });

    it("should bucket a read_only-suppressed mutating tool under ReadOnlyConnection in its connection section", () => {
      // The predicate (hasKafka) passes, so the only thing disabling this write
      // tool is the read-only overlay — it lands in the connection's section
      // under ReadOnlyConnection, the "flip the flag and these return" set.
      const mutatingTool = new StubHandler({
        predicate: hasKafka,
        annotations: CREATE_UPDATE,
      });
      const report = buildToolGatingReport(
        [[ToolName.CREATE_TOPICS, mutatingTool]],
        runtimeWith({ read_only: true, ...KAFKA_CONN }),
      );
      expect(report).toEqual({
        groupBy: "reason",
        operatorBlocked: [],
        connections: [
          {
            connectionId: "default",
            disabledGroups: [
              {
                reason: ToolDisabledReason.ReadOnlyConnection,
                tools: [ToolName.CREATE_TOPICS],
              },
            ],
            enabledCount: 0,
            disabledCount: 1,
          },
        ],
        enabledCount: 0,
        disabledCount: 1,
      });
    });

    it("should count a connection-dependent tool as disabled with no section on a zero-connection runtime", () => {
      const handler = stubWithPredicate(hasKafka);
      const report = buildToolGatingReport(
        [[ToolName.LIST_TOPICS, handler]],
        runtimeWithConnections({}),
      );
      expect(report).toEqual({
        groupBy: "reason",
        operatorBlocked: [],
        connections: [],
        enabledCount: 0,
        disabledCount: 1,
      });
    });

    it("should count a connection-independent tool as enabled on a zero-connection runtime", () => {
      const handler = stubWithPredicate(alwaysEnabled);
      const report = buildToolGatingReport(
        [[ToolName.SEARCH_PRODUCT_DOCS, handler]],
        runtimeWithConnections({}),
      );
      expect(report).toEqual({
        groupBy: "reason",
        operatorBlocked: [],
        connections: [],
        enabledCount: 1,
        disabledCount: 0,
      });
    });

    it("should preserve handler iteration order for tools within a single connection's reason bucket", () => {
      // Insertion order matters for the rendered text: handlers iterate in
      // registry-declaration order, and the diagnostic surface should show
      // tools in that same order so adjacent tools (e.g. all kafka tools)
      // stay visually grouped.
      const handlerA = stubWithPredicate(disabledForKafka);
      const handlerB = stubWithPredicate(disabledForKafka);
      const handlerC = stubWithPredicate(disabledForKafka);
      const report = buildToolGatingReport(
        [
          [ToolName.PRODUCE_MESSAGE, handlerA],
          [ToolName.LIST_TOPICS, handlerB],
          [ToolName.CREATE_TOPICS, handlerC],
        ],
        runtimeWith({}, "default"),
      );
      expect(report.connections[0]!.disabledGroups).toEqual([
        {
          reason: ToolDisabledReason.MissingKafkaBlock,
          tools: [
            ToolName.PRODUCE_MESSAGE,
            ToolName.LIST_TOPICS,
            ToolName.CREATE_TOPICS,
          ],
        },
      ]);
    });

    describe("operator allow/block-list (isToolAllowed)", () => {
      // An allow-list that admits only LIST_FLINK_STATEMENTS — every other
      // tool reads as operator-blocked through runtime.isToolAllowed.
      const onlyFlinkAllowed: ReadonlySet<ToolName> = new Set([
        ToolName.LIST_FLINK_STATEMENTS,
      ]);

      it("should report an operator-blocked tool whose predicate would pass as blocked, not enabled", () => {
        // The contradiction-with-tools/list bug: hasKafka passes on a kafka
        // connection, so pre-#558 this counted as enabled even though the
        // operator dropped it from the advertised set. It must land in
        // operatorBlocked and count as disabled.
        const handler = stubWithPredicate(hasKafka);
        const report = buildToolGatingReport(
          [[ToolName.LIST_TOPICS, handler]],
          runtimeWith(KAFKA_CONN, "default", undefined, onlyFlinkAllowed),
        );
        expect(report).toEqual({
          groupBy: "reason",
          operatorBlocked: [ToolName.LIST_TOPICS],
          connections: [
            {
              connectionId: "default",
              disabledGroups: [],
              enabledCount: 0,
              disabledCount: 0,
            },
          ],
          enabledCount: 0,
          disabledCount: 1,
        });
      });

      it("should not blame a config reason for an operator-blocked tool whose predicate also fails", () => {
        // hasKafka fails on a kafka-less connection, but the operator block is
        // the real story — the tool must appear in operatorBlocked and NOT in
        // the connection's MissingKafkaBlock bucket.
        const handler = stubWithPredicate(hasKafka);
        const report = buildToolGatingReport(
          [[ToolName.LIST_TOPICS, handler]],
          runtimeWith({}, "default", undefined, onlyFlinkAllowed),
        );
        expect(report).toEqual({
          groupBy: "reason",
          operatorBlocked: [ToolName.LIST_TOPICS],
          connections: [
            {
              connectionId: "default",
              disabledGroups: [],
              enabledCount: 0,
              disabledCount: 0,
            },
          ],
          enabledCount: 0,
          disabledCount: 1,
        });
      });

      it("should block even a connection-independent tool when the operator excludes it", () => {
        // alwaysEnabled would otherwise advertise this everywhere; the operator
        // block is the outermost gate and overrides connection-independence.
        const handler = stubWithPredicate(alwaysEnabled);
        const report = buildToolGatingReport(
          [[ToolName.SEARCH_PRODUCT_DOCS, handler]],
          runtimeWith(KAFKA_CONN, "default", undefined, onlyFlinkAllowed),
        );
        expect(report).toEqual({
          groupBy: "reason",
          operatorBlocked: [ToolName.SEARCH_PRODUCT_DOCS],
          connections: [
            {
              connectionId: "default",
              disabledGroups: [],
              enabledCount: 0,
              disabledCount: 0,
            },
          ],
          enabledCount: 0,
          disabledCount: 1,
        });
      });

      it("should subtract operator-blocked tools from each connection section's enabledCount", () => {
        // One allowed+enabled tool, one operator-blocked tool. The section's
        // enabledCount must count only the allowed one (1), never claiming the
        // blocked tool as enabled-on-this-connection.
        const allowedHandler = stubWithPredicate(hasKafka);
        const blockedHandler = stubWithPredicate(hasKafka);
        const report = buildToolGatingReport(
          [
            [ToolName.LIST_FLINK_STATEMENTS, allowedHandler],
            [ToolName.LIST_TOPICS, blockedHandler],
          ],
          runtimeWith(KAFKA_CONN, "default", undefined, onlyFlinkAllowed),
        );
        expect(report).toEqual({
          groupBy: "reason",
          operatorBlocked: [ToolName.LIST_TOPICS],
          connections: [
            {
              connectionId: "default",
              disabledGroups: [],
              enabledCount: 1,
              disabledCount: 0,
            },
          ],
          enabledCount: 1,
          disabledCount: 1,
        });
      });

      it("should leave operatorBlocked unchanged under groupBy=category", () => {
        // The operator block is axis-independent: the same server-wide list
        // appears whether bucketing by reason or by functional category.
        const handler = stubWithPredicate(hasKafka);
        const report = buildToolGatingReport(
          [[ToolName.LIST_TOPICS, handler]],
          runtimeWith({}, "default", undefined, onlyFlinkAllowed),
          "category",
        );
        expect(report).toEqual({
          groupBy: "category",
          operatorBlocked: [ToolName.LIST_TOPICS],
          connections: [
            {
              connectionId: "default",
              disabledGroups: [],
              enabledCount: 0,
              disabledCount: 0,
            },
          ],
          enabledCount: 0,
          disabledCount: 1,
        });
      });

      it("should preserve handler iteration order within operatorBlocked", () => {
        const a = stubWithPredicate(hasKafka);
        const b = stubWithPredicate(hasKafka);
        const c = stubWithPredicate(hasKafka);
        const report = buildToolGatingReport(
          [
            [ToolName.PRODUCE_MESSAGE, a],
            [ToolName.LIST_TOPICS, b],
            [ToolName.CREATE_TOPICS, c],
          ],
          runtimeWith(KAFKA_CONN, "default", undefined, new Set()),
        );
        expect(report.operatorBlocked).toEqual([
          ToolName.PRODUCE_MESSAGE,
          ToolName.LIST_TOPICS,
          ToolName.CREATE_TOPICS,
        ]);
      });
    });

    describe('groupBy: "category"', () => {
      // Both stubs land in ToolCategory.Kafka, but their predicates fail
      // for different reasons (MissingKafkaBlock vs MissingFlinkBlock).
      // Under the default "reason" axis they'd split into two buckets;
      // the "category" axis merges them — proving the bucket key really
      // is the category, not the reason.
      it('should merge same-category disabled tools under one bucket within the connection section when groupBy is "category"', () => {
        const sameCategoryKafkaReasonStub = stubWithPredicate(disabledForKafka);
        const sameCategoryFlinkReasonStub = stubWithPredicate(disabledForFlink);
        const report = buildToolGatingReport(
          [
            [ToolName.LIST_TOPICS, sameCategoryKafkaReasonStub],
            [ToolName.LIST_FLINK_STATEMENTS, sameCategoryFlinkReasonStub],
          ],
          runtimeWith({}, "default"),
          "category",
        );
        expect(report).toEqual({
          groupBy: "category",
          operatorBlocked: [],
          connections: [
            {
              connectionId: "default",
              disabledGroups: [
                {
                  category: ToolCategory.Kafka,
                  tools: [ToolName.LIST_TOPICS, ToolName.LIST_FLINK_STATEMENTS],
                },
              ],
              enabledCount: 0,
              disabledCount: 2,
            },
          ],
          enabledCount: 0,
          disabledCount: 2,
        });
      });

      it("should sort category-keyed buckets lex by category within a section", () => {
        // Two stubs with the same predicate (so reasons are identical
        // and the only differentiator is category) but distinct categories —
        // insertion order Tableflow-then-Billing, expected output
        // Billing-then-Tableflow.
        const tableflowCategoryStub = stubWithPredicate(
          disabledForKafka,
          ToolCategory.Tableflow,
        );
        const billingCategoryStub = stubWithPredicate(
          disabledForKafka,
          ToolCategory.Billing,
        );

        const report = buildToolGatingReport(
          [
            [ToolName.LIST_TABLEFLOW_TOPICS, tableflowCategoryStub],
            [ToolName.LIST_BILLING_COSTS, billingCategoryStub],
          ],
          runtimeWith({}, "default"),
          "category",
        );

        // ToolCategory values are kebab-case strings; `billing` sorts
        // before `tableflow` lexicographically regardless of insertion
        // order.
        expect(
          report.connections[0]!.disabledGroups.map((g) =>
            disabledToolGroupKey(g),
          ),
        ).toEqual([ToolCategory.Billing, ToolCategory.Tableflow]);
      });
    });
  });
});
