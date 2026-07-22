import type { DirectConnectionConfig } from "@src/config/models.js";
import type { CallToolResult } from "@src/confluent/schema.js";
import type { ToolHandler } from "@src/confluent/tools/base-tools.js";
import { CREATE_UPDATE, READ_ONLY } from "@src/confluent/tools/base-tools.js";
import type { ConnectionPredicate } from "@src/confluent/tools/connection-predicates.js";
import {
  alwaysEnabled,
  hasCCloudCatalogSupport,
  hasConfluentCloud,
  hasFlink,
  hasKafka,
  hasKafkaAuth,
  hasKafkaBootstrap,
  hasKafkaRestWithAuth,
  hasSchemaRegistry,
  hasTableflow,
  hasTelemetry,
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
        alreadyEnabled: false,
        connections: {
          default: {
            enabled: false,
            currentState: "no 'tableflow' block in connection config",
            suggestedYaml:
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
        alreadyEnabled: false,
        connections: {
          default: {
            enabled: false,
            currentState: "'kafka' block does not have 'auth' field",
            suggestedYaml:
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
        alreadyEnabled: true,
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
        alreadyEnabled: true,
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
      expect(advice).not.toHaveProperty("suggestedYaml");
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

    // Drive each ToolDisabledReason → suggested-YAML arm of adviceForReason
    // through handle(): a stub tool whose predicate yields the reason against a
    // connection shaped to trip exactly that gap.
    it.each<{
      reason: string;
      predicate: ConnectionPredicate;
      config: Omit<DirectConnectionConfig, "type">;
      expected: string;
    }>([
      {
        reason: "MissingKafkaBlock",
        predicate: hasKafka,
        config: {},
        expected: "    kafka:",
      },
      {
        reason: "MissingKafkaBootstrap",
        predicate: hasKafkaBootstrap,
        config: { kafka: { rest_endpoint: "https://r" } },
        expected: "bootstrap_servers",
      },
      {
        reason: "MissingKafkaRestEndpoint",
        predicate: hasKafkaRestWithAuth,
        config: { kafka: { bootstrap_servers: "b:9092" } },
        expected: "rest_endpoint",
      },
      {
        reason: "MissingSchemaRegistryBlock",
        predicate: hasSchemaRegistry,
        config: {},
        expected: "    schema_registry:",
      },
      {
        reason: "MissingSchemaRegistryApiKeyAuth",
        predicate: hasCCloudCatalogSupport,
        config: { schema_registry: { endpoint: "https://sr" } },
        expected: "    schema_registry:",
      },
      {
        reason: "MissingConfluentCloudBlock",
        predicate: hasConfluentCloud,
        config: {},
        expected: "    confluent_cloud:",
      },
      {
        reason: "MissingFlinkBlock",
        predicate: hasFlink,
        config: {},
        expected: "    flink:",
      },
      {
        reason: "MissingTelemetryBlock",
        predicate: hasTelemetry,
        config: {},
        expected: "    telemetry:",
      },
    ])("should suggest YAML for $reason", ({ predicate, config, expected }) => {
      const runtime = runtimeWithConnections({ default: config });

      const result = handlerWith([
        [ToolName.LIST_CONNECTORS, new StubHandler({ predicate })],
      ]).handle(runtime, { tool: ToolName.LIST_CONNECTORS });

      const advice = (
        result.structuredContent as {
          connections: Record<string, { suggestedYaml?: string }>;
        }
      ).connections.default!;
      expect(advice.suggestedYaml).toContain(expected);
    });

    it("should emit a note for an OAuth direct-only gap (OAuthNotDirectCapable)", () => {
      const result = handlerWith([
        [
          ToolName.LIST_CONNECTORS,
          new StubHandler({ predicate: hasConfluentCloud }),
        ],
      ]).handle(ccloudOAuthRuntime(), { tool: ToolName.LIST_CONNECTORS });

      const advice = Object.values(
        (
          result.structuredContent as {
            connections: Record<string, { note?: string }>;
          }
        ).connections,
      )[0]!;
      expect(advice).not.toHaveProperty("suggestedYaml");
      expect(advice.note).toContain("direct (api_key) connection");
    });

    it("should list every connection when a tool is already enabled on more than one", () => {
      const enabledTableflow = {
        tableflow: {
          auth: { type: "api_key" as const, key: "k", secret: "s" },
        },
      };
      const runtime = runtimeWithConnections({
        beta: enabledTableflow,
        alpha: enabledTableflow,
      });

      const result = handlerWith(universe()).handle(runtime, {
        tool: ToolName.LIST_TABLEFLOW_TOPICS,
      });

      // Connection ids are rendered sorted regardless of insertion order.
      expect(textOf(result)).toContain(
        "already enabled on connection(s): alpha, beta",
      );
    });

    it("should quote a connection id with YAML-significant characters in the suggested key", () => {
      // Connection ids are only constrained to non-empty trimmed strings, so an
      // id containing ':' would produce an invalid bare YAML key.
      const runtime = runtimeWithConnections({ "weird:id": {} });

      const result = handlerWith(universe()).handle(runtime, {
        tool: ToolName.LIST_TABLEFLOW_TOPICS,
      });

      const advice = (
        result.structuredContent as {
          connections: Record<string, { suggestedYaml?: string }>;
        }
      ).connections["weird:id"]!;
      expect(advice.suggestedYaml).toContain('connections:\n  "weird:id":\n');
    });

    it("should leave a plain connection id unquoted in the suggested key", () => {
      const runtime = runtimeWithConnections({ default: {} });

      const result = handlerWith(universe()).handle(runtime, {
        tool: ToolName.LIST_TABLEFLOW_TOPICS,
      });

      const advice = (
        result.structuredContent as {
          connections: Record<string, { suggestedYaml?: string }>;
        }
      ).connections.default!;
      expect(advice.suggestedYaml).toContain("connections:\n  default:\n");
    });

    it("should emit a note (and not throw) when a mutating tool is blocked by a read_only connection", () => {
      // The connection reaches the tableflow service, so the predicate passes;
      // it's the read_only overlay that disables a mutating tool. The advice is
      // a note to drop read_only, not a block-shaped YAML suggestion.
      const runtime = runtimeWithConnections({
        default: {
          tableflow: { auth: { type: "api_key", key: "k", secret: "s" } },
          read_only: true,
        },
      });

      const result = handlerWith([
        [
          ToolName.CREATE_TABLEFLOW_TOPIC,
          new StubHandler({
            predicate: hasTableflow,
            annotations: CREATE_UPDATE,
          }),
        ],
      ]).handle(runtime, { tool: ToolName.CREATE_TABLEFLOW_TOPIC });

      const advice = (
        result.structuredContent as {
          connections: Record<
            string,
            { enabled: boolean; note?: string; suggestedYaml?: string }
          >;
        }
      ).connections.default!;
      expect(advice.enabled).toBe(false);
      expect(advice).not.toHaveProperty("suggestedYaml");
      expect(advice.note).toContain("read_only");
      expect(result.isError).toBe(false);
      expect(textOf(result)).toContain("read_only");
    });

    it("should still suggest YAML for disabled connections when the tool is enabled on others", () => {
      // Partially-enabled: enabled on one connection, missing config on another.
      // The message must not claim "No config change needed" and must carry the
      // gap connection's YAML.
      const enabledTableflow = {
        tableflow: {
          auth: { type: "api_key" as const, key: "k", secret: "s" },
        },
      };
      const runtime = runtimeWithConnections({
        enabledConn: enabledTableflow,
        gapConn: {},
      });

      const result = handlerWith(universe()).handle(runtime, {
        tool: ToolName.LIST_TABLEFLOW_TOPICS,
      });

      const text = textOf(result);
      expect(text).toContain("already enabled on connection(s): enabledConn");
      expect(text).not.toContain("No config change needed");
      expect(text).toContain('connection "gapConn"');
      expect(text).toContain("tableflow:");

      const structured = result.structuredContent as {
        alreadyEnabled: boolean;
        connections: Record<
          string,
          { enabled: boolean; suggestedYaml?: string }
        >;
      };
      expect(structured.alreadyEnabled).toBe(true);
      expect(structured.connections.enabledConn!.enabled).toBe(true);
      expect(structured.connections.gapConn!.suggestedYaml).toContain(
        "tableflow:",
      );
    });

    it("should explain when no connections are configured", () => {
      const result = handlerWith(universe()).handle(
        runtimeWithConnections({}),
        { tool: ToolName.LIST_TABLEFLOW_TOPICS },
      );

      expect(result.structuredContent).toEqual({
        tool: ToolName.LIST_TABLEFLOW_TOPICS,
        alreadyEnabled: false,
        connections: {},
      });
      expect(textOf(result)).toContain("No connections are configured");
    });
  });
});
