import { CallToolResult } from "@src/confluent/schema.js";
import { READ_ONLY, ToolHandler } from "@src/confluent/tools/base-tools.js";
import {
  alwaysEnabled,
  hasKafka,
} from "@src/confluent/tools/connection-predicates.js";
import { ListConnectionsHandler } from "@src/confluent/tools/handlers/diagnostics/list-connections-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { runtimeWithConnections } from "@tests/factories/runtime.js";
import { StubHandler } from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

describe("ListConnectionsHandler", () => {
  const KAFKA = { kafka: { bootstrap_servers: "b:9092" } };

  function handlerWith(
    entries: Array<readonly [ToolName, ToolHandler]>,
  ): ListConnectionsHandler {
    return new ListConnectionsHandler(() => entries);
  }

  /** The three-tool universe shared by the mapping tests: two kafka-gated
   *  tools and one always-enabled (connection-agnostic) tool, the latter
   *  present to prove it is excluded from every per-connection list. */
  function threeToolUniverse(): Array<readonly [ToolName, ToolHandler]> {
    return [
      [ToolName.LIST_TOPICS, new StubHandler({ predicate: hasKafka })],
      [ToolName.CREATE_TOPICS, new StubHandler({ predicate: hasKafka })],
      [
        ToolName.SEARCH_PRODUCT_DOCS,
        new StubHandler({ predicate: alwaysEnabled }),
      ],
    ];
  }

  describe("getToolConfig()", () => {
    const config = handlerWith([]).getToolConfig();

    it("should name the tool list-connections", () => {
      expect(config.name).toBe(ToolName.LIST_CONNECTIONS);
    });

    it("should be read-only", () => {
      expect(config.annotations).toBe(READ_ONLY);
    });

    it("should take no input arguments", () => {
      expect(Object.keys(config.inputSchema)).toEqual([]);
    });
  });

  describe("handle()", () => {
    function textOf(result: CallToolResult): string {
      const first = result.content[0];
      return first?.type === "text" ? first.text : "";
    }

    it("should map each connection to its connection-routable tools, sorted, excluding connection-agnostic ones", () => {
      const runtime = runtimeWithConnections({ k: KAFKA, bare: {} });

      const result = handlerWith(threeToolUniverse()).handle(runtime);

      // SEARCH_PRODUCT_DOCS (alwaysEnabled) is connection-agnostic and absent
      // from both lists; "bare" therefore has no routable tools at all.
      expect(result.structuredContent).toEqual({
        connections: {
          k: { enabledTools: [ToolName.CREATE_TOPICS, ToolName.LIST_TOPICS] },
          bare: { enabledTools: [] },
        },
      });
      expect(result.isError).toBe(false);
    });

    it("should never list connection-agnostic (alwaysEnabled) tools, even when they are the only tools", () => {
      const runtime = runtimeWithConnections({ k: KAFKA, other: KAFKA });

      const result = handlerWith([
        [
          ToolName.SEARCH_PRODUCT_DOCS,
          new StubHandler({ predicate: alwaysEnabled }),
        ],
        [
          ToolName.GET_PRODUCT_DOC_PAGE,
          new StubHandler({ predicate: alwaysEnabled }),
        ],
      ]).handle(runtime);

      expect(result.structuredContent).toEqual({
        connections: {
          k: { enabledTools: [] },
          other: { enabledTools: [] },
        },
      });
    });

    it("should exclude tools blocked by the operator allow/block filter", () => {
      // CREATE_TOPICS is absent from the allow set, so it must not surface even
      // though its predicate enables it on "k". SEARCH_PRODUCT_DOCS is allowed
      // but connection-agnostic, so it is excluded for that reason instead.
      const runtime = runtimeWithConnections(
        { k: KAFKA },
        undefined,
        new Set([ToolName.LIST_TOPICS, ToolName.SEARCH_PRODUCT_DOCS]),
      );

      const result = handlerWith(threeToolUniverse()).handle(runtime);

      expect(result.structuredContent).toEqual({
        connections: { k: { enabledTools: [ToolName.LIST_TOPICS] } },
      });
    });

    it("should report a connection with zero enabled tools as an empty list rendered '(none)'", () => {
      // Universe is entirely kafka-gated, so a connection without a kafka block
      // ends up with no invokable tools.
      const runtime = runtimeWithConnections({ bare: {} });

      const result = handlerWith([
        [ToolName.LIST_TOPICS, new StubHandler({ predicate: hasKafka })],
      ]).handle(runtime);

      expect(result.structuredContent).toEqual({
        connections: { bare: { enabledTools: [] } },
      });
      expect(textOf(result)).toContain("bare (0 tools): (none)");
    });

    it("should return an empty mapping with explanatory text when no connections are configured", () => {
      const result = handlerWith(threeToolUniverse()).handle(
        runtimeWithConnections({}),
      );

      expect(result.structuredContent).toEqual({ connections: {} });
      expect(textOf(result)).toContain("No connections");
    });
  });
});
