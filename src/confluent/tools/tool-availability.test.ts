import { ToolHandler } from "@src/confluent/tools/base-tools.js";
import {
  ConnectionPredicate,
  ToolDisabledReason,
  alwaysEnabled,
} from "@src/confluent/tools/connection-predicates.js";
import { groupDisabledToolsByReason } from "@src/confluent/tools/tool-availability.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  KAFKA_CONN,
  bareRuntime,
  runtimeWith,
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
      // Predicate enables only on connections carrying a kafka block.
      const partiallyEnabled: ConnectionPredicate = (conn) =>
        conn.type === "direct" && conn.kafka !== undefined
          ? { enabled: true }
          : {
              enabled: false,
              reason: ToolDisabledReason.MissingKafkaBlock,
            };
      const handler = stubWithPredicate(partiallyEnabled);
      const runtime = runtimeWith(KAFKA_CONN);
      // Cast because `connections` is typed as `Readonly<Record<…>>`. We
      // splice in a second connection here rather than building a fresh
      // multi-connection ServerRuntime — the test only exercises the
      // grouping helper's read path.
      (
        runtime.config.connections as Record<
          string,
          (typeof runtime.config.connections)[string]
        >
      )["other"] = {
        type: "direct",
        schema_registry: { endpoint: "http://sr" },
      };
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
      const runtime = runtimeWith({}, "zeta");
      (
        runtime.config.connections as Record<
          string,
          (typeof runtime.config.connections)[string]
        >
      )["alpha"] = {
        type: "direct",
        schema_registry: { endpoint: "http://sr-alpha" },
      };

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
});
