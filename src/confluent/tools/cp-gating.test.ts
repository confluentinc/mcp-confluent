import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ToolHandlerRegistry } from "@src/confluent/tools/tool-registry.js";
import { runtimeWith } from "@tests/factories/runtime.js";
import { describe, expect, it } from "vitest";

/**
 * Behavioral guarantee for self-managed Confluent Platform deployments.
 *
 * A CP deployment is modeled in this codebase as a connection with kafka
 * (bootstrap + auth) plus schema_registry (endpoint + auth) and NO
 * confluent_cloud / flink / tableflow / telemetry blocks. With that shape,
 * every Cloud-only tool's predicate must fail and exactly the seven Kafka +
 * Schema Registry tools (plus the cloud-agnostic search-product-docs) must be
 * enabled.
 *
 * This test enumerates every registered handler and proves the categorical
 * invariant in a single place. Per-handler tests already cover the predicates
 * individually; this file exists so a future under-gating bug — a new tool
 * whose predicate accidentally fires on a CP-shaped runtime — fails in one
 * obvious place at unit-test time, instead of silently registering and 404'ing
 * when a CP user actually invokes it.
 */
describe("Confluent Platform tool gating", () => {
  const cpRuntime = runtimeWith({
    kafka: {
      bootstrap_servers: "cp-broker.internal:9092",
      auth: { type: "api_key", key: "k", secret: "s" },
    },
    schema_registry: {
      endpoint: "https://cp-sr.internal:8081",
      auth: { type: "api_key", key: "k", secret: "s" },
    },
  });

  /**
   * The full set of tools we expect a CP deployment to expose. Every other
   * registered tool must be disabled. Update this list when intentionally
   * adding a new CP-compatible tool; an unintended addition will surface as
   * a failing assertion in the "no other tools are enabled" test below.
   */
  const EXPECTED_ENABLED_ON_CP: readonly ToolName[] = [
    // Native Kafka admin
    ToolName.LIST_TOPICS,
    ToolName.CREATE_TOPICS,
    ToolName.DELETE_TOPICS,
    // Native Kafka producer/consumer
    ToolName.PRODUCE_MESSAGE,
    ToolName.CONSUME_MESSAGES,
    // Schema Registry
    ToolName.LIST_SCHEMAS,
    ToolName.DELETE_SCHEMA,
    // Cloud-agnostic public docs search (works on any connection)
    ToolName.SEARCH_PRODUCT_DOCS,
  ];

  const ALL_TOOL_NAMES = Object.values(ToolName);

  function isEnabledOnCp(name: ToolName): boolean {
    const handler = ToolHandlerRegistry.getToolHandler(name);
    return handler.enabledConnectionIds(cpRuntime).length > 0;
  }

  describe("expected-enabled tools", () => {
    for (const name of EXPECTED_ENABLED_ON_CP) {
      it(`${name} should be enabled on a CP-shaped runtime`, () => {
        expect(isEnabledOnCp(name)).toBe(true);
      });
    }
  });

  describe("every other registered tool", () => {
    const otherTools = ALL_TOOL_NAMES.filter(
      (name) => !EXPECTED_ENABLED_ON_CP.includes(name),
    );

    it("should find tools to check (sanity)", () => {
      expect(otherTools.length).toBeGreaterThan(0);
    });

    for (const name of otherTools) {
      it(`${name} should be disabled on a CP-shaped runtime`, () => {
        expect(isEnabledOnCp(name)).toBe(false);
      });
    }
  });
});
