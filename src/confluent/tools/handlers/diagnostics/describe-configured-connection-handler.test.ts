import { MCPServerConfiguration } from "@src/config/models.js";
import type { CallToolResult } from "@src/confluent/schema.js";
import type { ToolHandler } from "@src/confluent/tools/base-tools.js";
import { CREATE_UPDATE, READ_ONLY } from "@src/confluent/tools/base-tools.js";
import {
  alwaysEnabled,
  hasFlink,
  hasKafka,
  ToolDisabledReason,
} from "@src/confluent/tools/connection-predicates.js";
import { DescribeConfiguredConnectionHandler } from "@src/confluent/tools/handlers/diagnostics/describe-configured-connection-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { runtimeWithConnections } from "@tests/factories/runtime.js";
import { StubHandler } from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

describe("DescribeConfiguredConnectionHandler", () => {
  const KAFKA = { kafka: { bootstrap_servers: "b:9092" } };

  function handlerWith(
    entries: Array<readonly [ToolName, ToolHandler]>,
  ): DescribeConfiguredConnectionHandler {
    return new DescribeConfiguredConnectionHandler(() => entries);
  }

  /** Two kafka-gated tools (one read-only, one mutating) plus one always-enabled
   *  (connection-agnostic) tool, the latter present to prove it is excluded. */
  function threeToolUniverse(): Array<readonly [ToolName, ToolHandler]> {
    return [
      [ToolName.LIST_TOPICS, new StubHandler({ predicate: hasKafka })],
      [
        ToolName.CREATE_TOPICS,
        new StubHandler({ predicate: hasKafka, annotations: CREATE_UPDATE }),
      ],
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

    it("should name the tool describe-configured-connection", () => {
      expect(config.name).toBe("describe-configured-connection");
    });

    it("should be read-only", () => {
      expect(config.annotations).toBe(READ_ONLY);
    });

    it("should require a connectionId argument", () => {
      expect(Object.keys(config.inputSchema)).toEqual(["connectionId"]);
    });
  });

  describe("handle()", () => {
    it("should error and list the valid ids when the connectionId is unknown", () => {
      const runtime = runtimeWithConnections({ k: KAFKA, other: {} });

      const result = handlerWith(threeToolUniverse()).handle(runtime, {
        connectionId: "nope",
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('"nope"');
      expect(textOf(result)).toContain('"k"');
      expect(textOf(result)).toContain('"other"');
    });

    it("should partition routable tools into enabled and disabled-by-reason for the requested connection", () => {
      const runtime = runtimeWithConnections({ k: KAFKA, bare: {} });

      const result = handlerWith(threeToolUniverse()).handle(runtime, {
        connectionId: "bare",
      });

      expect(result.structuredContent).toEqual({
        connectionId: "bare",
        type: "direct",
        readOnly: false,
        blocks: {},
        enabledTools: [],
        disabledTools: {
          [ToolDisabledReason.MissingKafkaBlock]: [
            ToolName.CREATE_TOPICS,
            ToolName.LIST_TOPICS,
          ],
        },
      });
      expect(result.isError).toBe(false);
    });

    it("should list enabled routable tools sorted and exclude connection-agnostic ones", () => {
      const runtime = runtimeWithConnections({ k: KAFKA });

      const result = handlerWith(threeToolUniverse()).handle(runtime, {
        connectionId: "k",
      });

      expect(result.structuredContent).toEqual({
        connectionId: "k",
        type: "direct",
        readOnly: false,
        blocks: { kafka: { bootstrap_servers: "b:9092" } },
        enabledTools: [ToolName.CREATE_TOPICS, ToolName.LIST_TOPICS],
        disabledTools: {},
      });
    });

    it("should exclude tools blocked by the operator allow/block filter from both buckets", () => {
      const runtime = runtimeWithConnections(
        { bare: {} },
        undefined,
        new Set([ToolName.LIST_TOPICS, ToolName.SEARCH_PRODUCT_DOCS]),
      );

      const result = handlerWith(threeToolUniverse()).handle(runtime, {
        connectionId: "bare",
      });

      // CREATE_TOPICS is filtered out by the operator, so it appears in neither
      // bucket even though its predicate would disable it on a bare connection.
      expect(result.structuredContent).toEqual({
        connectionId: "bare",
        type: "direct",
        readOnly: false,
        blocks: {},
        enabledTools: [],
        disabledTools: {
          [ToolDisabledReason.MissingKafkaBlock]: [ToolName.LIST_TOPICS],
        },
      });
    });

    it("should echo a description and omit the key when there is none", () => {
      const withDesc = handlerWith(threeToolUniverse()).handle(
        runtimeWithConnections({ k: { description: "Prod east", ...KAFKA } }),
        { connectionId: "k" },
      );
      expect(
        (withDesc.structuredContent as { description?: string }).description,
      ).toBe("Prod east");

      const withoutDesc = handlerWith(threeToolUniverse()).handle(
        runtimeWithConnections({ k: KAFKA }),
        { connectionId: "k" },
      );
      expect(withoutDesc.structuredContent).not.toHaveProperty("description");
    });

    it("should segregate the read_only disabled bucket from service-block-missing buckets", () => {
      const runtime = runtimeWithConnections({
        prod: { read_only: true, ...KAFKA },
      });

      const result = handlerWith([
        [ToolName.LIST_TOPICS, new StubHandler({ predicate: hasKafka })],
        [
          ToolName.CREATE_TOPICS,
          new StubHandler({ predicate: hasKafka, annotations: CREATE_UPDATE }),
        ],
        [
          ToolName.LIST_FLINK_STATEMENTS,
          new StubHandler({ predicate: hasFlink }),
        ],
      ]).handle(runtime, { connectionId: "prod" });

      expect(result.structuredContent).toEqual({
        connectionId: "prod",
        type: "direct",
        readOnly: true,
        blocks: { kafka: { bootstrap_servers: "b:9092" } },
        enabledTools: [ToolName.LIST_TOPICS],
        disabledTools: {
          [ToolDisabledReason.ReadOnlyConnection]: [ToolName.CREATE_TOPICS],
          [ToolDisabledReason.MissingFlinkBlock]: [
            ToolName.LIST_FLINK_STATEMENTS,
          ],
        },
      });
    });

    it("should render the affirmative writes-suppressed line for a read_only connection", () => {
      const runtime = runtimeWithConnections({
        prod: { read_only: true, ...KAFKA },
      });

      const result = handlerWith([
        [ToolName.LIST_TOPICS, new StubHandler({ predicate: hasKafka })],
        [
          ToolName.CREATE_TOPICS,
          new StubHandler({ predicate: hasKafka, annotations: CREATE_UPDATE }),
        ],
      ]).handle(runtime, { connectionId: "prod" });

      expect(textOf(result)).toContain(
        `1 mutating tool suppressed by read_only: ${ToolName.CREATE_TOPICS}`,
      );
    });

    it("should surface non-secret block fields and never the auth credentials", () => {
      const runtime = runtimeWithConnections({
        k: {
          kafka: {
            bootstrap_servers: "b:9092",
            cluster_id: "lkc-1",
            auth: { type: "api_key", key: "KEY", secret: "SEKRET" },
          },
        },
      });

      const result = handlerWith(threeToolUniverse()).handle(runtime, {
        connectionId: "k",
      });

      const { blocks } = result.structuredContent as {
        blocks: { kafka: Record<string, unknown> };
      };
      expect(blocks.kafka).toEqual({
        bootstrap_servers: "b:9092",
        cluster_id: "lkc-1",
      });
      expect(JSON.stringify(result.structuredContent)).not.toContain("SEKRET");
    });

    it("should describe an oauth connection with empty blocks and its public scalars", () => {
      const runtime = new ServerRuntime(
        new MCPServerConfiguration({
          connections: {
            cloud: {
              type: "oauth",
              ccloud_env: "stag",
              kafka_debug: "security",
            },
          },
        }),
        {},
      );

      const result = handlerWith(threeToolUniverse()).handle(runtime, {
        connectionId: "cloud",
      });

      expect(result.structuredContent).toEqual({
        connectionId: "cloud",
        type: "oauth",
        ccloud_env: "stag",
        kafka_debug: "security",
        readOnly: false,
        blocks: {},
        // Both stub tools are kafka-gated; OAuth carries no service blocks, so
        // both land in the OAuth disabled bucket.
        enabledTools: [],
        disabledTools: {
          [ToolDisabledReason.OAuthNoServiceBlocks]: [
            ToolName.CREATE_TOPICS,
            ToolName.LIST_TOPICS,
          ],
        },
      });
    });

    it("should render a readable text summary with sorted blocks and the disabled section", () => {
      const runtime = runtimeWithConnections({
        k: {
          kafka: { bootstrap_servers: "b:9092" },
          confluent_cloud: {
            endpoint: "https://api.confluent.cloud",
            auth: { type: "api_key" as const, key: "k", secret: "s" },
          },
        },
      });

      const result = handlerWith([
        [ToolName.LIST_TOPICS, new StubHandler({ predicate: hasKafka })],
        [ToolName.CREATE_TOPICS, new StubHandler({ predicate: hasKafka })],
        [
          ToolName.LIST_FLINK_STATEMENTS,
          new StubHandler({ predicate: hasFlink }),
        ],
      ]).handle(runtime, { connectionId: "k" });

      const text = textOf(result);
      expect(text).toContain('Connection "k" (direct)');
      expect(text).not.toContain("read-only");
      // Block names rendered sorted, proving the comparator runs with 2+ blocks.
      expect(text).toContain("Configured blocks: confluent_cloud, kafka");
      expect(text).toContain(
        `2 tools enabled: ${ToolName.CREATE_TOPICS}, ${ToolName.LIST_TOPICS}`,
      );
      expect(text).toContain("1 tool disabled:");
      expect(text).toContain(
        `  ${ToolDisabledReason.MissingFlinkBlock} (1): ${ToolName.LIST_FLINK_STATEMENTS}`,
      );
    });

    it("should report 'none' as the valid-id list when no connections are configured", () => {
      const result = handlerWith(threeToolUniverse()).handle(
        runtimeWithConnections({}),
        { connectionId: "whatever" },
      );

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Configured connections: none.");
    });
  });
});
