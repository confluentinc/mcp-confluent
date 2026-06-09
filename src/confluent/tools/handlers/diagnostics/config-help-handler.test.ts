import { CallToolResult } from "@src/confluent/schema.js";
import { READ_ONLY, ToolHandler } from "@src/confluent/tools/base-tools.js";
import {
  alwaysEnabled,
  hasKafkaAuth,
  hasTableflow,
} from "@src/confluent/tools/connection-predicates.js";
import { ConfigHelpHandler } from "@src/confluent/tools/handlers/diagnostics/config-help-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  ccloudOAuthRuntime,
  runtimeWithConnections,
} from "@tests/factories/runtime.js";
import { StubHandler } from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

describe("ConfigHelpHandler", () => {
  function handlerWith(
    entries: Array<readonly [ToolName, ToolHandler]>,
  ): ConfigHelpHandler {
    return new ConfigHelpHandler(() => entries);
  }

  /** A universe with one tableflow-gated tool, one kafka-auth-gated tool, and
   *  one connection-agnostic tool — enough to exercise block-level,
   *  field-level, and always-enabled gaps. */
  function universe(): Array<readonly [ToolName, ToolHandler]> {
    return [
      [
        ToolName.LIST_TABLEFLOW_TOPICS,
        new StubHandler({ predicate: hasTableflow }),
      ],
      [ToolName.LIST_CONNECTORS, new StubHandler({ predicate: hasKafkaAuth })],
      [
        ToolName.SEARCH_PRODUCT_DOCS,
        new StubHandler({ predicate: alwaysEnabled }),
      ],
    ];
  }

  function textOf(result: CallToolResult): string {
    const first = result.content[0];
    return first?.type === "text" ? first.text : "";
  }

  describe("getToolConfig()", () => {
    const config = handlerWith([]).getToolConfig();

    it("should name the tool config-help", () => {
      expect(config.name).toBe("config-help");
    });

    it("should be read-only", () => {
      expect(config.annotations).toBe(READ_ONLY);
    });

    it("should require a tool argument", () => {
      expect(Object.keys(config.inputSchema)).toEqual(["tool"]);
    });
  });

  describe("handle()", () => {
    it("should suggest the missing block's YAML for a disabled tool", () => {
      const runtime = runtimeWithConnections({ default: {} });

      const result = handlerWith(universe()).handle(runtime, {
        tool: ToolName.LIST_TABLEFLOW_TOPICS,
      });

      expect(result.structuredContent).toEqual({
        tool: ToolName.LIST_TABLEFLOW_TOPICS,
        already_enabled: false,
        connections: {
          default: {
            enabled: false,
            current_state: "no 'tableflow' block in connection config",
            suggested_yaml:
              'connections:\n  default:\n    tableflow:\n      auth:\n        type: api_key\n        key: "${TABLEFLOW_API_KEY}"\n        secret: "${TABLEFLOW_API_SECRET}"',
          },
        },
      });
      expect(result.isError).toBe(false);
      expect(textOf(result)).toContain(
        'Tool "list-tableflow-topics" is disabled on all 1 configured connection(s)',
      );
    });

    it("should suggest a field-level fix when the block exists but a field is missing", () => {
      // kafka block present (bootstrap only) but no auth: the gap is the auth
      // field, not the whole block.
      const runtime = runtimeWithConnections({
        default: { kafka: { bootstrap_servers: "b:9092" } },
      });

      const result = handlerWith(universe()).handle(runtime, {
        tool: ToolName.LIST_CONNECTORS,
      });

      expect(result.structuredContent).toEqual({
        tool: ToolName.LIST_CONNECTORS,
        already_enabled: false,
        connections: {
          default: {
            enabled: false,
            current_state: "'kafka' block does not have 'auth' field",
            suggested_yaml:
              'connections:\n  default:\n    kafka:\n      auth:\n        type: api_key\n        key: "${KAFKA_API_KEY}"\n        secret: "${KAFKA_API_SECRET}"',
          },
        },
      });
    });

    it("should report a tool that is already enabled without suggesting YAML", () => {
      const runtime = runtimeWithConnections({
        default: {
          tableflow: { auth: { type: "api_key", key: "k", secret: "s" } },
        },
      });

      const result = handlerWith(universe()).handle(runtime, {
        tool: ToolName.LIST_TABLEFLOW_TOPICS,
      });

      expect(result.structuredContent).toEqual({
        tool: ToolName.LIST_TABLEFLOW_TOPICS,
        already_enabled: true,
        connections: { default: { enabled: true } },
      });
      expect(textOf(result)).toContain(
        'Tool "list-tableflow-topics" is already enabled on connection(s): default',
      );
    });

    it("should treat a connection-agnostic (alwaysEnabled) tool as already enabled", () => {
      const runtime = runtimeWithConnections({ default: {} });

      const result = handlerWith(universe()).handle(runtime, {
        tool: ToolName.SEARCH_PRODUCT_DOCS,
      });

      expect(result.structuredContent).toMatchObject({
        already_enabled: true,
        connections: { default: { enabled: true } },
      });
    });

    it("should emit a note instead of YAML when the connection is OAuth", () => {
      const result = handlerWith(universe()).handle(ccloudOAuthRuntime(), {
        tool: ToolName.LIST_TABLEFLOW_TOPICS,
      });

      const connections = (
        result.structuredContent as {
          connections: Record<string, Record<string, unknown>>;
        }
      ).connections;
      const advice = Object.values(connections)[0]!;
      expect(advice.enabled).toBe(false);
      expect(advice).not.toHaveProperty("suggested_yaml");
      expect(advice.note).toContain("OAuth connection");
    });

    it("should return an error for an unknown tool name", () => {
      const runtime = runtimeWithConnections({ default: {} });

      const result = handlerWith(universe()).handle(runtime, {
        tool: "not-a-real-tool",
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('Unknown tool "not-a-real-tool"');
    });

    it("should throw a ZodError when the tool argument is missing", () => {
      const runtime = runtimeWithConnections({ default: {} });
      expect(() => handlerWith(universe()).handle(runtime, {})).toThrow();
    });

    it("should explain when no connections are configured", () => {
      const result = handlerWith(universe()).handle(
        runtimeWithConnections({}),
        { tool: ToolName.LIST_TABLEFLOW_TOPICS },
      );

      expect(result.structuredContent).toEqual({
        tool: ToolName.LIST_TABLEFLOW_TOPICS,
        already_enabled: false,
        connections: {},
      });
      expect(textOf(result)).toContain("No connections are configured");
    });
  });
});
