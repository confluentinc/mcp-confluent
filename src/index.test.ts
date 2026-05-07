import { nodeCrypto } from "@src/confluent/node-deps.js";
import type { ToolConfig } from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ToolHandlerRegistry } from "@src/confluent/tools/tool-registry.js";
import {
  getToolHandlersToRegister,
  outputApiKey,
  outputToolList,
} from "@src/index.js";
import { ccloudOAuthRuntime, runtimeWith } from "@tests/factories/runtime.js";
import { StubHandler } from "@tests/stubs/index.js";
import {
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";

describe("index.ts", () => {
  let consoleLog: MockInstance<typeof console.log>;

  beforeEach(() => {
    consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  describe("outputToolList()", () => {
    it("should not call console.log when the tool list is empty", () => {
      outputToolList([]);
      expect(consoleLog).not.toHaveBeenCalled();
    });

    it("should call console.log once for a single tool", () => {
      outputToolList([ToolName.LIST_TOPICS]);
      expect(consoleLog).toHaveBeenCalledOnce();
    });

    it("should call console.log once per tool for multiple tools", () => {
      outputToolList([
        ToolName.LIST_TOPICS,
        ToolName.CREATE_TOPICS,
        ToolName.DELETE_TOPICS,
      ]);
      expect(consoleLog).toHaveBeenCalledTimes(3);
    });

    it("should include the tool name in the output line", () => {
      outputToolList([ToolName.LIST_TOPICS]);
      const output = consoleLog.mock.calls[0]![0] as string;
      expect(output).toContain(ToolName.LIST_TOPICS);
    });

    it("should include the full description when it is within 120 characters", () => {
      const shortDesc = "A short description.";
      vi.spyOn(ToolHandlerRegistry, "getToolConfig").mockReturnValue({
        name: ToolName.LIST_TOPICS,
        description: shortDesc,
        inputSchema: {},
        annotations: {},
      } as ToolConfig);

      outputToolList([ToolName.LIST_TOPICS]);

      const output = consoleLog.mock.calls[0]![0] as string;
      expect(output).toContain(shortDesc);
      expect(output).not.toContain("...");
    });

    it("should truncate descriptions longer than 120 characters with ellipsis", () => {
      const longDesc = "x".repeat(150);
      vi.spyOn(ToolHandlerRegistry, "getToolConfig").mockReturnValue({
        name: ToolName.LIST_TOPICS,
        description: longDesc,
        inputSchema: {},
        annotations: {},
      } as ToolConfig);

      outputToolList([ToolName.LIST_TOPICS]);

      const output = consoleLog.mock.calls[0]![0] as string;
      expect(output).toContain("...");
      // ANSI codes only wrap the tool name before the ": " separator, so
      // splitting there isolates the description without needing regex stripping.
      const descPart = output.split(": ").slice(1).join(": ");
      expect(descPart.length).toBe(120);
    });
  });

  describe("getToolHandlersToRegister()", () => {
    it("should include a tool when enabledConnectionIds returns connection IDs", () => {
      vi.spyOn(ToolHandlerRegistry, "getToolHandler").mockReturnValue(
        new StubHandler(),
      );

      const result = getToolHandlersToRegister(
        [ToolName.LIST_TOPICS],
        runtimeWith(),
      );

      expect(result.has(ToolName.LIST_TOPICS)).toBe(true);
    });

    it("should exclude a tool when enabledConnectionIds returns empty", () => {
      vi.spyOn(ToolHandlerRegistry, "getToolHandler").mockReturnValue(
        new StubHandler({ enabled: false }),
      );

      expect(() =>
        getToolHandlersToRegister([ToolName.LIST_TOPICS], runtimeWith()),
      ).toThrow("No tools enabled");
    });

    it("should exclude a tool absent from filteredToolNames", () => {
      const getToolHandler = vi.spyOn(ToolHandlerRegistry, "getToolHandler");

      expect(() =>
        getToolHandlersToRegister(
          [], // LIST_TOPICS not in the allowed set
          runtimeWith(),
        ),
      ).toThrow("No tools enabled");

      expect(getToolHandler).not.toHaveBeenCalled();
    });

    it("should throw when enabledConnectionIds returns an ID not present in the config", () => {
      const handler = new StubHandler();
      vi.spyOn(handler, "enabledConnectionIds").mockReturnValue([
        "nonexistent-connection",
      ]);
      vi.spyOn(ToolHandlerRegistry, "getToolHandler").mockReturnValue(handler);

      expect(() =>
        getToolHandlersToRegister([ToolName.LIST_TOPICS], runtimeWith()),
      ).toThrow(
        "Tool list-topics: enabledConnectionIds() returned unknown connection ID(s): nonexistent-connection",
      );
    });

    it("should include only the tool whose enabledConnectionIds returns IDs when tools have mixed results", () => {
      const listHandler = new StubHandler();
      const createHandler = new StubHandler({ enabled: false });
      vi.spyOn(ToolHandlerRegistry, "getToolHandler").mockImplementation(
        (name) => {
          if (name === ToolName.LIST_TOPICS) return listHandler;
          if (name === ToolName.CREATE_TOPICS) return createHandler;
          throw new Error(`unexpected tool ${name}`);
        },
      );

      const result = getToolHandlersToRegister(
        [ToolName.LIST_TOPICS, ToolName.CREATE_TOPICS],
        runtimeWith(),
      );

      expect(result.has(ToolName.LIST_TOPICS)).toBe(true);
      expect(result.has(ToolName.CREATE_TOPICS)).toBe(false);
    });

    // Capstone: starting from a literal YAML fixture, prove which tools the
    // registry advertises as enabled when the sole connection is OAuth-typed.
    // Two source-of-truth lists, EXPECTED_OAUTH_ENABLED and EXPECTED_OAUTH_DISABLED,
    // must together cover the ToolName enum exactly once.
    describe("against configed OAuth connection", () => {
      const EXPECTED_OAUTH_ENABLED: readonly ToolName[] = [
        ToolName.LIST_TOPICS,
        ToolName.CREATE_TOPICS,
        ToolName.DELETE_TOPICS,
        ToolName.PRODUCE_MESSAGE,
        ToolName.CONSUME_MESSAGES,
        ToolName.LIST_ENVIRONMENTS,
        ToolName.READ_ENVIRONMENT,
        ToolName.LIST_ORGANIZATIONS,
        ToolName.LIST_BILLING_COSTS,
        ToolName.SEARCH_PRODUCT_DOCS,
      ];

      const EXPECTED_OAUTH_DISABLED: readonly ToolName[] = [
        // Flink (hasFlink — needs the flink service block)
        ToolName.LIST_FLINK_STATEMENTS,
        ToolName.CREATE_FLINK_STATEMENT,
        ToolName.READ_FLINK_STATEMENT,
        ToolName.DELETE_FLINK_STATEMENTS,
        ToolName.GET_FLINK_STATEMENT_EXCEPTIONS,
        ToolName.LIST_FLINK_CATALOGS,
        ToolName.LIST_FLINK_DATABASES,
        ToolName.LIST_FLINK_TABLES,
        ToolName.DESCRIBE_FLINK_TABLE,
        ToolName.GET_FLINK_TABLE_INFO,
        ToolName.CHECK_FLINK_STATEMENT_HEALTH,
        ToolName.DETECT_FLINK_STATEMENT_ISSUES,
        ToolName.GET_FLINK_STATEMENT_PROFILE,
        // Connect (hasKafkaRestWithAuth / hasKafkaAuth — needs the kafka block)
        ToolName.LIST_CONNECTORS,
        ToolName.READ_CONNECTOR,
        ToolName.CREATE_CONNECTOR,
        ToolName.DELETE_CONNECTOR,
        // Catalog / search (hasCCloudCatalogSupport — needs the schema_registry block)
        ToolName.SEARCH_TOPICS_BY_TAG,
        ToolName.SEARCH_TOPICS_BY_NAME,
        ToolName.CREATE_TOPIC_TAGS,
        ToolName.DELETE_TAG,
        ToolName.REMOVE_TAG_FROM_ENTITY,
        ToolName.ADD_TAGS_TO_TOPIC,
        ToolName.LIST_TAGS,
        // Kafka REST (hasKafkaRestWithAuth — needs rest_endpoint + auth on kafka block)
        ToolName.ALTER_TOPIC_CONFIG,
        ToolName.GET_TOPIC_CONFIG,
        // CCloud — handler calls getSoleDirectConnection() so it stays unwrapped
        // (no widenForOAuth) until the handler is migrated.
        ToolName.LIST_CLUSTERS,
        // Schema Registry (hasSchemaRegistry)
        ToolName.LIST_SCHEMAS,
        ToolName.DELETE_SCHEMA,
        // Tableflow (hasTableflow — needs the tableflow service block)
        ToolName.CREATE_TABLEFLOW_TOPIC,
        ToolName.LIST_TABLEFLOW_REGIONS,
        ToolName.LIST_TABLEFLOW_TOPICS,
        ToolName.READ_TABLEFLOW_TOPIC,
        ToolName.UPDATE_TABLEFLOW_TOPIC,
        ToolName.DELETE_TABLEFLOW_TOPIC,
        ToolName.CREATE_TABLEFLOW_CATALOG_INTEGRATION,
        ToolName.LIST_TABLEFLOW_CATALOG_INTEGRATIONS,
        ToolName.READ_TABLEFLOW_CATALOG_INTEGRATION,
        ToolName.UPDATE_TABLEFLOW_CATALOG_INTEGRATION,
        ToolName.DELETE_TABLEFLOW_CATALOG_INTEGRATION,
        // Telemetry (hasTelemetry — needs the telemetry service block)
        ToolName.QUERY_METRICS,
        ToolName.LIST_METRICS,
      ];

      it("should partition every ToolName into exactly one of EXPECTED_OAUTH_ENABLED or EXPECTED_OAUTH_DISABLED", () => {
        const enabled = new Set(EXPECTED_OAUTH_ENABLED);
        const disabled = new Set(EXPECTED_OAUTH_DISABLED);

        const overlap = [...enabled].filter((t) => disabled.has(t));
        expect(overlap).toEqual([]);

        const uncategorized = Object.values(ToolName).filter(
          (t) => !enabled.has(t) && !disabled.has(t),
        );
        expect(uncategorized).toEqual([]);
      });

      it("should enable exactly EXPECTED_OAUTH_ENABLED under an OAuth connection", () => {
        const registered = getToolHandlersToRegister(
          Object.values(ToolName),
          ccloudOAuthRuntime(),
        );

        expect([...registered.keys()].sort()).toEqual(
          [...EXPECTED_OAUTH_ENABLED].sort(),
        );
      });
    });
  });

  describe("outputApiKey()", () => {
    // generateApiKey produces a 64-char hex string from 32 random bytes.
    // Stubbing the underlying randomBytes lets us assert deterministic output.
    const FAKE_BYTES = Buffer.alloc(32, 0xab);
    const EXPECTED_API_KEY = "ab".repeat(32);
    let randomBytesSpy: MockInstance<typeof nodeCrypto.randomBytes>;

    beforeEach(() => {
      randomBytesSpy = vi
        .spyOn(nodeCrypto, "randomBytes")
        .mockReturnValue(FAKE_BYTES);
    });

    it("should generate exactly one API key per invocation", () => {
      outputApiKey();
      expect(randomBytesSpy).toHaveBeenCalledOnce();
    });

    it("should print the generated key to console.log", () => {
      outputApiKey();
      const allArgs: unknown[] = consoleLog.mock.calls.flat();
      expect(allArgs).toContain(EXPECTED_API_KEY);
    });
  });
});
