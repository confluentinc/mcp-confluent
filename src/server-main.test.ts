import type { CLIOptions } from "@src/cli.js";
import {
  DEFAULT_SERVER_CONFIG,
  MCPServerConfiguration,
} from "@src/config/models.js";
import * as nodeDeps from "@src/confluent/node-deps.js";
import { nodeCrypto } from "@src/confluent/node-deps.js";
import {
  ToolCategory,
  type ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ToolHandlerRegistry } from "@src/confluent/tools/tool-registry.js";
import { logger } from "@src/logger.js";
import { TransportType } from "@src/mcp/transports/types.js";
import {
  getToolHandlersToRegister,
  handleEarlyExits,
  outputApiKey,
  outputInitConfig,
  outputToolList,
  performCleanup,
  resolveAllowedToolNames,
  resolveTelemetryWriteKey,
} from "@src/server-main.js";
import { ServerRuntime } from "@src/server-runtime.js";
import {
  ccloudOAuthRuntime,
  runtimeWith,
  runtimeWithConnections,
} from "@tests/factories/runtime.js";
import { StubHandler } from "@tests/stubs/index.js";
import {
  createFsWrappers,
  type MockedFsWrappers,
} from "@tests/stubs/node-deps.js";
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

/**
 * Build a CLIOptions value with sane defaults so each test only spells out the
 * flag(s) it cares about. Mirrors the shape produced by `parseCliArgs` for the
 * no-flags-given case (transports defaulted to [stdio]; everything else
 * undefined or false).
 */
function makeCliOptions(overrides: Partial<CLIOptions> = {}): CLIOptions {
  return {
    transports: [TransportType.STDIO],
    listTools: false,
    generateKey: false,
    initConfig: false,
    initOauthConfig: false,
    ...overrides,
  };
}

/**
 * Capture-and-mute logger.warn so test assertions can pin grouped warning
 * format without polluting test output.
 */
function spyOnLoggerWarn(): MockInstance<typeof logger.warn> {
  return vi.spyOn(logger, "warn").mockImplementation((() => {}) as never);
}

describe("server-main.ts", () => {
  let consoleLog: MockInstance<typeof console.log>;

  beforeEach(() => {
    consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  describe("outputToolList()", () => {
    /** Concatenate every console.log invocation into a single string so
     *  tests can search the whole output without indexing into specific
     *  rows — the grouped layout makes per-call indexing fragile. */
    function allOutput(spy: MockInstance<typeof console.log>): string {
      return spy.mock.calls.map((args) => args.join(" ")).join("\n");
    }

    /** Install a single mock handler that {@linkcode outputToolList} will
     *  pick up via `ToolHandlerRegistry.getToolHandler`. The default
     *  StubHandler already declares `category = ToolCategory.Kafka`, so
     *  callers only need to override the description. */
    function withStubbedConfig(description: string): void {
      const handler = new StubHandler();
      vi.spyOn(handler, "getToolConfig").mockReturnValue({
        name: ToolName.LIST_TOPICS,
        description,
        inputSchema: {},
        annotations: {},
      } as ToolConfig);
      vi.spyOn(ToolHandlerRegistry, "getToolHandler").mockReturnValue(handler);
    }

    it("should not call console.log when the tool list is empty", () => {
      outputToolList([]);
      expect(consoleLog).not.toHaveBeenCalled();
    });

    it("should print a category section header plus one tool row for a single tool", () => {
      outputToolList([ToolName.LIST_TOPICS]);
      // 1 header + 1 row, no trailing blank (last section).
      expect(consoleLog).toHaveBeenCalledTimes(2);
    });

    it("should print one header plus N rows when N tools share a single category", () => {
      outputToolList([
        ToolName.LIST_TOPICS,
        ToolName.CREATE_TOPICS,
        ToolName.DELETE_TOPICS,
      ]);
      // All three are kafka: 1 header + 3 rows, no inter-section blank.
      expect(consoleLog).toHaveBeenCalledTimes(4);
    });

    it("should emit a blank-line separator between adjacent category sections but not after the last", () => {
      outputToolList([ToolName.LIST_TOPICS, ToolName.LIST_FLINK_STATEMENTS]);
      // 2 headers + 2 rows + 1 separator (between the two sections) = 5.
      expect(consoleLog).toHaveBeenCalledTimes(5);
      // The separator lives between the two sections; its argument is "".
      const blankCalls = consoleLog.mock.calls.filter((args) => args[0] === "");
      expect(blankCalls).toHaveLength(1);
    });

    it("should include the tool's category header in the output", () => {
      outputToolList([ToolName.LIST_TOPICS]);
      expect(allOutput(consoleLog)).toContain(ToolCategory.Kafka);
    });

    it("should include the tool name on its row", () => {
      outputToolList([ToolName.LIST_TOPICS]);
      expect(allOutput(consoleLog)).toContain(ToolName.LIST_TOPICS);
    });

    it("should include the full description when it is within 120 characters", () => {
      const shortDesc = "A short description.";
      withStubbedConfig(shortDesc);

      outputToolList([ToolName.LIST_TOPICS]);

      const output = allOutput(consoleLog);
      expect(output).toContain(shortDesc);
      expect(output).not.toContain("...");
    });

    it("should truncate descriptions longer than 120 characters with ellipsis", () => {
      const longDesc = "x".repeat(150);
      withStubbedConfig(longDesc);

      outputToolList([ToolName.LIST_TOPICS]);

      // Find the tool row by the colon-separator pattern; the header line
      // lacks a trailing description.
      const toolRow = consoleLog.mock.calls
        .map((args) => args[0] as string)
        .find((line) => line.includes(`${ToolName.LIST_TOPICS}\x1b[0m: `));
      expect(toolRow).toBeDefined();
      expect(toolRow).toContain("...");
      // ANSI codes only wrap the tool name before the ": " separator, so
      // splitting there isolates the description without needing regex stripping.
      const descPart = toolRow!.split(": ").slice(1).join(": ");
      expect(descPart.length).toBe(120);
    });
  });

  describe("getToolHandlersToRegister()", () => {
    /** A single-(empty)-connection runtime whose operator allow-list is exactly
     * `allowed` — the candidate set Pass 1 will consider. Pass no args for an
     * empty allow-list (nothing invokable). */
    function runtimeAllowing(...allowed: ToolName[]): ServerRuntime {
      return runtimeWith({}, undefined, undefined, new Set(allowed));
    }

    it("should include a tool when enabledConnectionIds returns connection IDs", () => {
      vi.spyOn(ToolHandlerRegistry, "getToolHandler").mockReturnValue(
        new StubHandler(),
      );

      const result = getToolHandlersToRegister(
        runtimeAllowing(ToolName.LIST_TOPICS),
      );

      expect(result.has(ToolName.LIST_TOPICS)).toBe(true);
    });

    it("should exclude a tool when enabledConnectionIds returns empty", () => {
      vi.spyOn(ToolHandlerRegistry, "getToolHandler").mockReturnValue(
        new StubHandler({ enabled: false }),
      );

      expect(() =>
        getToolHandlersToRegister(runtimeAllowing(ToolName.LIST_TOPICS)),
      ).toThrow("No tools enabled");
    });

    it("should exclude a tool absent from the runtime's allowed set", () => {
      const getToolHandler = vi.spyOn(ToolHandlerRegistry, "getToolHandler");

      expect(
        () => getToolHandlersToRegister(runtimeAllowing()), // empty allow-list
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
        getToolHandlersToRegister(runtimeAllowing(ToolName.LIST_TOPICS)),
      ).toThrow(
        "Wacky -- Tool list-topics: enabledConnectionIds() returned unknown connection ID(s): nonexistent-connection",
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
        runtimeAllowing(ToolName.LIST_TOPICS, ToolName.CREATE_TOPICS),
      );

      expect(result.has(ToolName.LIST_TOPICS)).toBe(true);
      expect(result.has(ToolName.CREATE_TOPICS)).toBe(false);
    });

    it("should register the connection-independent tools on a zero-connection config", () => {
      const result = getToolHandlersToRegister(runtimeWithConnections({}));

      expect(result.has(ToolName.SEARCH_PRODUCT_DOCS)).toBe(true);
      expect(result.has(ToolName.GET_PRODUCT_DOC_PAGE)).toBe(true);
      expect(result.has(ToolName.LIST_CONFIGURED_CONNECTIONS)).toBe(true);
      expect(result.has(ToolName.EXPLAIN_DISABLED_TOOLS)).toBe(true);
      // A connection-dependent tool has no connection to enable it.
      expect(result.has(ToolName.LIST_TOPICS)).toBe(false);
    });

    it("should emit one grouped warn per (connectionId, reason) for fully-disabled tools", () => {
      const warnSpy = spyOnLoggerWarn();
      vi.spyOn(ToolHandlerRegistry, "getToolHandler").mockImplementation(
        (name) => {
          if (name === ToolName.LIST_TOPICS) return new StubHandler();
          // Both disabled-stub tools share the same arbitrary reason
          // (`MissingFlinkBlock`), so they should collapse into a single
          // grouped warn line listing both names.
          return new StubHandler({ enabled: false });
        },
      );

      getToolHandlersToRegister(
        runtimeAllowing(
          ToolName.LIST_TOPICS,
          ToolName.CREATE_TOPICS,
          ToolName.DELETE_TOPICS,
        ),
      );

      const warningMessages = warnSpy.mock.calls
        .map((call) => call[0])
        .filter(
          (msg): msg is string =>
            typeof msg === "string" && msg.startsWith("Tools disabled"),
        );

      expect(warningMessages).toHaveLength(1);
      expect(warningMessages[0]).toBe(
        `Tools disabled on connection 'default' — no 'flink' block in connection config: ${ToolName.CREATE_TOPICS}, ${ToolName.DELETE_TOPICS}`,
      );
    });

    // Capstone: starting from a literal YAML fixture, prove which tools the
    // registry advertises as enabled when the sole connection is OAuth-typed.
    // Two source-of-truth lists, EXPECTED_OAUTH_ENABLED and EXPECTED_OAUTH_DISABLED,
    // must together cover the ToolName enum exactly once.
    describe("against configured OAuth connection", () => {
      const EXPECTED_OAUTH_ENABLED: readonly ToolName[] = [
        ToolName.LIST_TOPICS,
        ToolName.CREATE_TOPICS,
        ToolName.DELETE_TOPICS,
        ToolName.PRODUCE_MESSAGE,
        ToolName.CONSUME_MESSAGES,
        ToolName.GET_PARTITION_OFFSETS,
        ToolName.LIST_CONSUMER_GROUPS,
        ToolName.DESCRIBE_CONSUMER_GROUP,
        ToolName.GET_CONSUMER_GROUP_LAG,
        ToolName.LIST_ENVIRONMENTS,
        ToolName.READ_ENVIRONMENT,
        ToolName.LIST_ORGANIZATIONS,
        ToolName.LIST_BILLING_COSTS,
        ToolName.SEARCH_PRODUCT_DOCS,
        ToolName.GET_PRODUCT_DOC_PAGE,
        ToolName.ALTER_TOPIC_CONFIG,
        ToolName.GET_TOPIC_CONFIG,
        ToolName.LIST_CLUSTERS,
        ToolName.LIST_COMPUTE_POOLS,
        ToolName.EXPLAIN_DISABLED_TOOLS,
        ToolName.LIST_CONFIGURED_CONNECTIONS,
        ToolName.CONFIG_HELP,
        ToolName.DESCRIBE_CONFIGURED_CONNECTION,
        // Schema Registry (hasSchemaRegistryOrOAuth)
        ToolName.LIST_SCHEMAS,
        ToolName.CREATE_SCHEMA,
        ToolName.DELETE_SCHEMA,
        // Connect (hasConfluentCloudOrOAuth — ride the cloud REST client).
        // create-connector is excluded: it embeds a Kafka API key/secret in the
        // connector spec, which an OAuth connection cannot supply.
        ToolName.LIST_CONNECTORS,
        ToolName.GET_CONNECTOR_CONFIG,
        ToolName.GET_CONNECTOR_OFFSETS,
        ToolName.GET_CONNECTOR_STATUS,
        ToolName.GET_CONNECTOR_TASKS,
        ToolName.DELETE_CONNECTOR,
        ToolName.GET_CONNECTOR_ERROR_SUMMARY,
        ToolName.GET_CONNECTOR_ERROR_RECOMMENDATIONS,
        ToolName.GET_CONNECTOR_LOGS,
        ToolName.PAUSE_CONNECTOR,
        ToolName.RESUME_CONNECTOR,
        ToolName.RESTART_CONNECTOR,
        ToolName.UPDATE_CONNECTOR_CONFIG,
        // Catalog + search (hasCCloudCatalogOrOAuth — ride the SR REST client,
        // which auto-resolves the SR cluster + endpoint from environment_id).
        ToolName.SEARCH_TOPICS_BY_TAG,
        ToolName.SEARCH_TOPICS_BY_NAME,
        ToolName.CREATE_TOPIC_TAGS,
        ToolName.DELETE_TAG,
        ToolName.REMOVE_TAG_FROM_ENTITY,
        ToolName.ADD_TAGS_TO_TOPIC,
        ToolName.LIST_TAGS,
        // Telemetry / Metrics (hasTelemetryOrOAuth — the Telemetry REST base
        // URL is derived from the Auth0 environment and the surface is
        // cloud-wide, so no per-cluster/per-env routing is needed).
        ToolName.QUERY_METRICS,
        ToolName.LIST_METRICS,
        // Tableflow (hasTableflowOrOAuth — the Tableflow REST surface rides the
        // cloud control-plane URL/token; environment/cluster IDs are supplied as
        // explicit tool arguments under OAuth).
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
        // Flink (hasFlinkOrOAuth / flinkWithTelemetryOrOAuth — the Flink REST host
        // is regional and resolved per call from the compute pool; org/env/
        // compute-pool IDs are supplied as explicit tool arguments under OAuth).
        ToolName.LIST_FLINK_STATEMENTS,
        ToolName.CREATE_FLINK_STATEMENT,
        ToolName.GET_FLINK_STATEMENT_RESULTS,
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
      ];

      const EXPECTED_OAUTH_DISABLED: readonly ToolName[] = [
        // Connect — only create-connector stays disabled (canCreateDirectConnector
        // is direct-only: it embeds a Kafka API key/secret in the connector spec).
        ToolName.CREATE_CONNECTOR,
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
        const registered = getToolHandlersToRegister(ccloudOAuthRuntime());

        expect([...registered.keys()].sort()).toEqual(
          [...EXPECTED_OAUTH_ENABLED].sort(),
        );
      });
    });
  });

  describe("resolveAllowedToolNames()", () => {
    it("should return undefined when neither an allow nor a block list is configured", () => {
      // The `undefined` sentinel keeps ServerRuntime in its "no filter" state
      // rather than carrying an all-tools set that means the same thing.
      expect(resolveAllowedToolNames([], [])).toBeUndefined();
    });

    it("should restrict to exactly the allow list when one is provided", () => {
      const allowed = resolveAllowedToolNames([ToolName.LIST_TOPICS], []);
      expect(allowed).toBeInstanceOf(Set);
      expect(allowed?.has(ToolName.LIST_TOPICS)).toBe(true);
      expect(allowed?.has(ToolName.CREATE_TOPICS)).toBe(false);
    });

    it("should return a set excluding the block list when only a block list is provided", () => {
      const allowed = resolveAllowedToolNames([], [ToolName.LIST_TOPICS]);
      expect(allowed?.has(ToolName.LIST_TOPICS)).toBe(false);
      expect(allowed?.has(ToolName.CREATE_TOPICS)).toBe(true);
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

  describe("outputInitConfig()", () => {
    const DEST_PATH = "/cwd/config.yaml";
    const GITIGNORE_PATH = "/cwd/.gitignore";
    const EXAMPLE_CONTENTS = "server: { transports: [stdio] }\n";

    let fsMocks: MockedFsWrappers;

    beforeEach(() => {
      fsMocks = createFsWrappers();
      // path.resolve("config.yaml") → /cwd/config.yaml
      vi.spyOn(nodeDeps.path, "resolve").mockReturnValue(DEST_PATH);
      // path.dirname(/cwd/config.yaml) → /cwd
      vi.spyOn(nodeDeps.path, "dirname").mockReturnValue("/cwd");
      // path.basename(/cwd/config.yaml) → config.yaml
      vi.spyOn(nodeDeps.path, "basename").mockReturnValue("config.yaml");
      // path.join("/cwd", ".gitignore") → /cwd/.gitignore
      vi.spyOn(nodeDeps.path, "join").mockReturnValue(GITIGNORE_PATH);
    });

    it("should refuse to overwrite an existing config.yaml", () => {
      // The exclusive-create write throws EEXIST when the destination
      // already exists; outputInitConfig converts it to the friendly error.
      fsMocks.readFileSync.mockReturnValue(EXAMPLE_CONTENTS);
      const eexist: NodeJS.ErrnoException = Object.assign(
        new Error("EEXIST: file already exists"),
        { code: "EEXIST" },
      );
      fsMocks.writeFileSync.mockImplementation(() => {
        throw eexist;
      });

      expect(() => outputInitConfig()).toThrow(/config\.yaml already exists/);
      expect(() => outputInitConfig()).toThrow(/--init-config/);
      // Failed write must not be followed by gitignore mutation.
      expect(fsMocks.appendFileSync).not.toHaveBeenCalled();
    });

    it("should reference --init-oauth-config in the EEXIST error when oauth=true", () => {
      fsMocks.readFileSync.mockReturnValue(EXAMPLE_CONTENTS);
      const eexist: NodeJS.ErrnoException = Object.assign(
        new Error("EEXIST: file already exists"),
        { code: "EEXIST" },
      );
      fsMocks.writeFileSync.mockImplementation(() => {
        throw eexist;
      });

      expect(() => outputInitConfig(true)).toThrow(/--init-oauth-config/);
    });

    it("should read the OAuth example template when oauth=true", () => {
      fsMocks.existsSync.mockReturnValue(false);
      fsMocks.readFileSync.mockReturnValue(EXAMPLE_CONTENTS);

      outputInitConfig(true);

      // The first readFileSync resolves the bundled template URL; assert
      // the basename it points at matches the OAuth example, not the
      // direct/api-key one. The second readFileSync (the gitignore) is
      // skipped here — existsSync(false) short-circuits that path.
      const sourceUrl = fsMocks.readFileSync.mock.calls[0]![0] as URL;
      expect(sourceUrl.pathname).toMatch(/config\.oauth\.example\.yaml$/);
    });

    it("should read the direct example template when oauth is omitted", () => {
      fsMocks.existsSync.mockReturnValue(false);
      fsMocks.readFileSync.mockReturnValue(EXAMPLE_CONTENTS);

      outputInitConfig();

      const sourceUrl = fsMocks.readFileSync.mock.calls[0]![0] as URL;
      expect(sourceUrl.pathname).toMatch(/config\.example\.yaml$/);
      expect(sourceUrl.pathname).not.toMatch(/oauth\.example\.yaml$/);
    });

    it("should propagate non-EEXIST write errors verbatim", () => {
      fsMocks.readFileSync.mockReturnValue(EXAMPLE_CONTENTS);
      const eacces: NodeJS.ErrnoException = Object.assign(
        new Error("EACCES: permission denied"),
        { code: "EACCES" },
      );
      fsMocks.writeFileSync.mockImplementation(() => {
        throw eacces;
      });

      expect(() => outputInitConfig()).toThrow(eacces);
    });

    it("should write the bundled example to ./config.yaml with an exclusive-create flag", () => {
      // No .gitignore yet.
      fsMocks.existsSync.mockReturnValue(false);
      fsMocks.readFileSync.mockReturnValue(EXAMPLE_CONTENTS);

      outputInitConfig();

      // The first writeFileSync writes the config with `wx` (exclusive create);
      // the second creates the gitignore (since existsSync returned false for it too).
      expect(fsMocks.writeFileSync).toHaveBeenNthCalledWith(
        1,
        DEST_PATH,
        EXAMPLE_CONTENTS,
        { flag: "wx" },
      );
    });

    it("should create .gitignore with the file basename when it does not exist", () => {
      fsMocks.existsSync.mockReturnValue(false);
      fsMocks.readFileSync.mockReturnValue(EXAMPLE_CONTENTS);

      outputInitConfig();

      expect(fsMocks.writeFileSync).toHaveBeenCalledWith(
        GITIGNORE_PATH,
        "config.yaml\n",
      );
      expect(fsMocks.appendFileSync).not.toHaveBeenCalled();
      const allArgs = consoleLog.mock.calls.flat().join(" ");
      expect(allArgs).toContain("added to .gitignore");
    });

    it("should append the file basename when .gitignore exists without it", () => {
      fsMocks.existsSync.mockImplementation((p) => p === GITIGNORE_PATH);
      // First readFileSync = the bundled example; second = the gitignore.
      fsMocks.readFileSync
        .mockReturnValueOnce(EXAMPLE_CONTENTS)
        .mockReturnValueOnce("node_modules\n.env\n");

      outputInitConfig();

      expect(fsMocks.appendFileSync).toHaveBeenCalledWith(
        GITIGNORE_PATH,
        "config.yaml\n",
      );
      const allArgs = consoleLog.mock.calls.flat().join(" ");
      expect(allArgs).toContain("added to .gitignore");
    });

    it("should prepend a newline before appending if .gitignore lacks a trailing newline", () => {
      fsMocks.existsSync.mockImplementation((p) => p === GITIGNORE_PATH);
      fsMocks.readFileSync
        .mockReturnValueOnce(EXAMPLE_CONTENTS)
        .mockReturnValueOnce("node_modules"); // no trailing newline

      outputInitConfig();

      expect(fsMocks.appendFileSync).toHaveBeenCalledWith(
        GITIGNORE_PATH,
        "\nconfig.yaml\n",
      );
    });

    it("should not append when .gitignore already lists the basename", () => {
      fsMocks.existsSync.mockImplementation((p) => p === GITIGNORE_PATH);
      fsMocks.readFileSync
        .mockReturnValueOnce(EXAMPLE_CONTENTS)
        .mockReturnValueOnce("node_modules\nconfig.yaml\n.env\n");

      outputInitConfig();

      expect(fsMocks.appendFileSync).not.toHaveBeenCalled();
      const allArgs = consoleLog.mock.calls.flat().join(" ");
      expect(allArgs).toContain(".gitignore already excludes it");
    });

    it("should ignore surrounding whitespace when matching existing .gitignore lines", () => {
      fsMocks.existsSync.mockImplementation((p) => p === GITIGNORE_PATH);
      fsMocks.readFileSync
        .mockReturnValueOnce(EXAMPLE_CONTENTS)
        .mockReturnValueOnce("  config.yaml  \n");

      outputInitConfig();

      expect(fsMocks.appendFileSync).not.toHaveBeenCalled();
    });

    it("should print the credential-edit hint when oauth is omitted", () => {
      // The api-key template ships placeholder credentials the user must
      // fill in before the server can connect, so the next-step message
      // must call that out.
      fsMocks.existsSync.mockReturnValue(false);
      fsMocks.readFileSync.mockReturnValue(EXAMPLE_CONTENTS);

      outputInitConfig();

      const messages = consoleLog.mock.calls.map((c) => c[0]).join(" ");
      expect(messages).toContain("Next: edit credentials in config.yaml");
    });

    it("should print a credentials-free next-step hint when oauth=true", () => {
      // OAuth has no credentials to provision; the bundled template is
      // runnable as-is. The next-step message must not tell the user to
      // edit credentials that don't exist.
      fsMocks.existsSync.mockReturnValue(false);
      fsMocks.readFileSync.mockReturnValue(EXAMPLE_CONTENTS);

      outputInitConfig(true);

      const messages = consoleLog.mock.calls.map((c) => c[0]).join(" ");
      expect(messages).toContain("Next: run with --config ./config.yaml");
      expect(messages).not.toContain("credentials");
    });
  });

  describe("handleEarlyExits()", () => {
    const FAKE_BYTES = Buffer.alloc(32, 0xab);

    let fsMocks: MockedFsWrappers;

    beforeEach(() => {
      fsMocks = createFsWrappers();
      // Path stubs cover both the api-key and OAuth init-config branches
      // (which share an outputInitConfig path), even when the test only
      // exercises one of them — keeps each test's setup minimal.
      vi.spyOn(nodeDeps.path, "resolve").mockReturnValue("/cwd/config.yaml");
      vi.spyOn(nodeDeps.path, "dirname").mockReturnValue("/cwd");
      vi.spyOn(nodeDeps.path, "basename").mockReturnValue("config.yaml");
      vi.spyOn(nodeDeps.path, "join").mockReturnValue("/cwd/.gitignore");
      // randomBytes only matters for the generate-key branch, but stubbing
      // it unconditionally avoids real entropy use if a test accidentally
      // exercises that path.
      vi.spyOn(nodeCrypto, "randomBytes").mockReturnValue(FAKE_BYTES);
    });

    it("should return { handled: false } when no early-exit flag is set", () => {
      expect(handleEarlyExits(makeCliOptions())).toEqual({ handled: false });
    });

    it("should print the API key and return { handled: true, exitCode: 0 } when generateKey is set", () => {
      const result = handleEarlyExits(makeCliOptions({ generateKey: true }));

      expect(result).toEqual({ handled: true, exitCode: 0 });
      const allArgs = consoleLog.mock.calls.flat().join(" ");
      expect(allArgs).toContain("Generated MCP API Key:");
    });

    it("should load the direct template and return success when initConfig is set", () => {
      fsMocks.existsSync.mockReturnValue(false);
      fsMocks.readFileSync.mockReturnValue("");

      const result = handleEarlyExits(makeCliOptions({ initConfig: true }));

      expect(result).toEqual({ handled: true, exitCode: 0 });
      const sourceUrl = fsMocks.readFileSync.mock.calls[0]![0] as URL;
      expect(sourceUrl.pathname).toMatch(/config\.example\.yaml$/);
      expect(sourceUrl.pathname).not.toMatch(/oauth\.example\.yaml$/);
    });

    it("should load the OAuth template and return success when initOauthConfig is set", () => {
      fsMocks.existsSync.mockReturnValue(false);
      fsMocks.readFileSync.mockReturnValue("");

      const result = handleEarlyExits(
        makeCliOptions({ initOauthConfig: true }),
      );

      expect(result).toEqual({ handled: true, exitCode: 0 });
      const sourceUrl = fsMocks.readFileSync.mock.calls[0]![0] as URL;
      expect(sourceUrl.pathname).toMatch(/config\.oauth\.example\.yaml$/);
    });

    it("should return exitCode 1 with --init-config stderr prefix when initConfig fails with EEXIST", () => {
      fsMocks.readFileSync.mockReturnValue("");
      const eexist: NodeJS.ErrnoException = Object.assign(
        new Error("EEXIST: file already exists"),
        { code: "EEXIST" },
      );
      fsMocks.writeFileSync.mockImplementation(() => {
        throw eexist;
      });

      const result = handleEarlyExits(makeCliOptions({ initConfig: true }));

      expect(result).toMatchObject({
        handled: true,
        exitCode: 1,
        stderr: expect.stringContaining("--init-config failed:"),
      });
    });

    it("should return exitCode 1 with --init-oauth-config stderr prefix when initOauthConfig fails", () => {
      // Same EEXIST failure shape as the previous test, but the prefix
      // must be the OAuth flag — that mapping is the bit under test.
      fsMocks.readFileSync.mockReturnValue("");
      const eexist: NodeJS.ErrnoException = Object.assign(
        new Error("EEXIST: file already exists"),
        { code: "EEXIST" },
      );
      fsMocks.writeFileSync.mockImplementation(() => {
        throw eexist;
      });

      const result = handleEarlyExits(
        makeCliOptions({ initOauthConfig: true }),
      );

      expect(result).toMatchObject({
        handled: true,
        exitCode: 1,
        stderr: expect.stringContaining("--init-oauth-config failed:"),
      });
    });

    it("should print the tool list and return success when listTools is set", () => {
      const result = handleEarlyExits(
        makeCliOptions({
          listTools: true,
          allowTools: [ToolName.LIST_TOPICS],
        }),
      );

      expect(result).toEqual({ handled: true, exitCode: 0 });
      // outputToolList emits one console.log per tool name; with a single
      // allow-listed tool we expect at least one call.
      expect(consoleLog).toHaveBeenCalled();
    });

    it("should give generateKey precedence over other concurrently-set early-exit flags", () => {
      // The parser enforces init-config XOR init-oauth-config, but the
      // remaining four-way combinations aren't statically excluded.
      // handleEarlyExits resolves them by source order — generateKey
      // first — and this test pins that order so a future reorder
      // can't silently change the user-visible behavior.
      fsMocks.readFileSync.mockReturnValue("");

      const result = handleEarlyExits(
        makeCliOptions({
          generateKey: true,
          initConfig: true,
          listTools: true,
        }),
      );

      expect(result).toEqual({ handled: true, exitCode: 0 });
      const allArgs = consoleLog.mock.calls.flat().join(" ");
      expect(allArgs).toContain("Generated MCP API Key:");
      // The init-config branch is bypassed entirely.
      expect(fsMocks.writeFileSync).not.toHaveBeenCalled();
    });
  });

  describe("resolveTelemetryWriteKey()", () => {
    // Build a minimal MCPServerConfiguration whose only point of variation is
    // the `server.analytics.write_key` field. Spreads DEFAULT_SERVER_CONFIG so
    // the literal-type widening on transports/log_level/etc. is sidestepped.
    function configWithAnalytics(
      writeKey: string | undefined,
    ): MCPServerConfiguration {
      return new MCPServerConfiguration({
        connections: { default: { type: "direct" } },
        server:
          writeKey === undefined
            ? DEFAULT_SERVER_CONFIG
            : { ...DEFAULT_SERVER_CONFIG, analytics: { write_key: writeKey } },
      });
    }

    it("should return the YAML-supplied write_key when server.analytics is present", () => {
      vi.spyOn(
        nodeDeps.buildConfig,
        "TELEMETRY_WRITE_KEY",
        "get",
      ).mockReturnValue("packed-key");

      const result = resolveTelemetryWriteKey(configWithAnalytics("yaml-key"));

      expect(result).toBe("yaml-key");
    });

    it("should fall back to buildConfig.TELEMETRY_WRITE_KEY when server.analytics is absent", () => {
      vi.spyOn(
        nodeDeps.buildConfig,
        "TELEMETRY_WRITE_KEY",
        "get",
      ).mockReturnValue("packed-key");

      const result = resolveTelemetryWriteKey(configWithAnalytics(undefined));

      expect(result).toBe("packed-key");
    });

    it("should return undefined when neither YAML nor buildConfig supplies a key", () => {
      vi.spyOn(
        nodeDeps.buildConfig,
        "TELEMETRY_WRITE_KEY",
        "get",
      ).mockReturnValue("");

      const result = resolveTelemetryWriteKey(configWithAnalytics(undefined));

      // Empty-string buildConfig is the unpacked/dev-build shape; treat it as
      // "no key supplied" so the caller routes through TelemetryService's
      // falsy-writeKey disabled path rather than passing "" to Segment.
      expect(result).toBeFalsy();
    });
  });

  describe("performCleanup()", () => {
    function cleanupDeps() {
      return {
        telemetry: { shutdown: vi.fn().mockResolvedValue(undefined) },
        transportManager: { stop: vi.fn().mockResolvedValue(undefined) },
        runtime: { oauthHolder: undefined, disconnectAll: vi.fn() },
      };
    }

    it("should run every shutdown step then exit 0", async () => {
      const deps = cleanupDeps();
      deps.runtime.disconnectAll.mockResolvedValue(undefined);
      const exit = vi.fn();

      await performCleanup(deps, exit);

      expect(deps.telemetry.shutdown).toHaveBeenCalledOnce();
      expect(deps.transportManager.stop).toHaveBeenCalledOnce();
      expect(deps.runtime.disconnectAll).toHaveBeenCalledOnce();
      expect(exit).toHaveBeenCalledOnce();
      expect(exit).toHaveBeenCalledWith(0);
    });

    it("should still exit 0 when a shutdown step rejects", async () => {
      const deps = cleanupDeps();
      deps.runtime.disconnectAll.mockRejectedValue(
        new Error("disconnect boom"),
      );
      const exit = vi.fn();

      await performCleanup(deps, exit);

      expect(exit).toHaveBeenCalledOnce();
      expect(exit).toHaveBeenCalledWith(0);
    });
  });
});
