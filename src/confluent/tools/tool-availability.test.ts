import { ToolDomain, ToolHandler } from "@src/confluent/tools/base-tools.js";
import {
  ConnectionPredicate,
  PredicateResult,
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

function stubWithPredicate(predicate: ConnectionPredicate): ToolHandler {
  const handler = new StubHandler();
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

/**
 * Returns a {@linkcode ToolHandler} whose `connectionVerdicts()` resolves
 * to an empty map — the invariant-violation shape the diagnostic tool
 * guards against. `BaseToolHandler.connectionVerdicts` is documented as
 * `@final` but the test deliberately monkey-patches the instance method
 * to reach a branch that should be unreachable in production (every
 * runtime carries at least one connection by `enforceSingleConnectionOnly`).
 */
function handlerWithEmptyVerdicts(): ToolHandler {
  const handler = new StubHandler();
  (
    handler as unknown as {
      connectionVerdicts: () => Map<string, PredicateResult>;
    }
  ).connectionVerdicts = () => new Map();
  return handler;
}

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
    it("should produce an empty report with zero counts when no tools are passed", () => {
      const report = buildToolGatingReport([], runtimeWith({}, "default"));
      expect(report).toEqual({
        groupBy: "reason",
        disabledGroups: [],
        enabledCount: 0,
        disabledCount: 0,
      });
    });

    it("should report each tool as enabled and emit no disabledGroups when every tool passes its predicate", () => {
      const handler = stubWithPredicate(alwaysEnabled);
      const report = buildToolGatingReport(
        [[ToolName.LIST_TOPICS, handler]],
        runtimeWith(KAFKA_CONN),
      );
      expect(report).toEqual({
        groupBy: "reason",
        disabledGroups: [],
        enabledCount: 1,
        disabledCount: 0,
      });
    });

    it("should group fully-disabled tools by reason, sorted lex by reason", () => {
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
      });
    });

    it("should classify a tool as enabled when at least one configured connection passes its predicate, omitting it from disabledGroups (lossy v1 flatten)", () => {
      // Pins the v1 single-connection-scope behaviour against a synthesised
      // multi-connection runtime: a tool enabled on `with-kafka` and
      // disabled on `without-kafka` is reported as enabled overall, with
      // no entry in `disabledGroups`. The asymmetry is dropped — the v2
      // per-connection / cross-connection-deltas shape (see
      // ToolGatingReport JSDoc) is the proper fix for this. This test
      // exists so the lossy aggregation is documented in code rather
      // than implied by prose.
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
        disabledGroups: [],
        enabledCount: 1,
        disabledCount: 0,
      });
    });

    it("should throw a 'Wacky --' error when a handler returns an empty verdict map (invariant violation)", () => {
      // The empty-verdict-map case means a tool's `connectionVerdicts()`
      // returned no entries — which only happens if `runtime.config.connections`
      // is empty, which `enforceSingleConnectionOnly()` should have prevented
      // at bootstrap. The diagnostic tool fails loudly with a `Wacky --`
      // message rather than fabricating a misleading reason (e.g. the
      // never-applicable `OAuthNoServiceBlocks`) and shipping it in the
      // operator-facing report.
      expect(() =>
        buildToolGatingReport(
          [[ToolName.LIST_TOPICS, handlerWithEmptyVerdicts()]],
          runtimeWith({}),
        ),
      ).toThrow(/Wacky --.*empty verdict map/i);
    });

    it("should preserve handler iteration order for tools within a single reason group", () => {
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
      expect(report.disabledGroups).toEqual([
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

    describe('groupBy: "domain"', () => {
      // StubHandler hard-codes `domain = ToolDomain.Kafka`; that's
      // sufficient to prove the axis switch — the same handler under
      // the default "reason" axis buckets by ToolDisabledReason
      // (see preceding tests).
      it("should bucket disabled tools by handler.domain when groupBy is 'domain'", () => {
        const kafkaTool = stubWithPredicate(disabledForKafka);
        const flinkTool = stubWithPredicate(disabledForFlink);
        const report = buildToolGatingReport(
          [
            [ToolName.LIST_TOPICS, kafkaTool],
            [ToolName.LIST_FLINK_STATEMENTS, flinkTool],
          ],
          runtimeWith({}, "default"),
          "domain",
        );
        expect(report).toEqual({
          groupBy: "domain",
          disabledGroups: [
            {
              domain: ToolDomain.Kafka,
              tools: [ToolName.LIST_TOPICS, ToolName.LIST_FLINK_STATEMENTS],
            },
          ],
          enabledCount: 0,
          disabledCount: 2,
        });
      });

      it("should sort domain-keyed groups lex by domain", () => {
        const a = new StubHandler();
        (a as unknown as { predicate: ConnectionPredicate }).predicate =
          disabledForKafka;
        (a as unknown as { domain: ToolDomain }).domain = ToolDomain.Tableflow;

        const b = new StubHandler();
        (b as unknown as { predicate: ConnectionPredicate }).predicate =
          disabledForKafka;
        (b as unknown as { domain: ToolDomain }).domain = ToolDomain.Billing;

        const report = buildToolGatingReport(
          [
            [ToolName.LIST_TABLEFLOW_TOPICS, a],
            [ToolName.LIST_BILLING_COSTS, b],
          ],
          runtimeWith({}, "default"),
          "domain",
        );

        // ToolDomain values are kebab-case strings; `billing` sorts
        // before `tableflow` lexicographically regardless of insertion
        // order.
        expect(
          report.disabledGroups.map((g) => disabledToolGroupKey(g)),
        ).toEqual([ToolDomain.Billing, ToolDomain.Tableflow]);
      });
    });
  });
});
