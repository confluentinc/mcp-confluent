import type { CLIOptions } from "@src/cli.js";
import {
  DEFAULT_SERVER_CONFIG,
  MCPServerConfiguration,
} from "@src/config/models.js";
import * as nodeDeps from "@src/confluent/node-deps.js";
import { nodeCrypto } from "@src/confluent/node-deps.js";
import type { ToolConfig } from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ToolHandlerRegistry } from "@src/confluent/tools/tool-registry.js";
import {
  getToolHandlersToRegister,
  handleEarlyExits,
  outputApiKey,
  outputInitConfig,
  outputToolList,
  resolveTelemetryWriteKey,
} from "@src/index.js";
import { logger } from "@src/logger.js";
import { ccloudOAuthRuntime, runtimeWith } from "@tests/factories/runtime.js";
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
  type MockInstance,
  vi,
} from "vitest";

/**
 * Build a CLIOptions value with sane defaults so each test only spells out the
 * flag(s) it cares about. Mirrors the shape produced by `parseCliArgs` for the
 * no-flags-given case (transports defaulted to [stdio]; everything else
 * undefined or false).
 */
function makeCliOptions(overrides: Partial<CLIOptions> = {}): CLIOptions {
  return {
    transports: [],
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
        [ToolName.LIST_TOPICS, ToolName.CREATE_TOPICS, ToolName.DELETE_TOPICS],
        runtimeWith(),
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
        ToolName.LIST_ENVIRONMENTS,
        ToolName.READ_ENVIRONMENT,
        ToolName.LIST_ORGANIZATIONS,
        ToolName.LIST_BILLING_COSTS,
        ToolName.SEARCH_PRODUCT_DOCS,
        ToolName.GET_PRODUCT_DOC_PAGE,
        ToolName.ALTER_TOPIC_CONFIG,
        ToolName.GET_TOPIC_CONFIG,
        ToolName.LIST_CLUSTERS,
        ToolName.EXPLAIN_DISABLED_TOOLS,
        // Schema Registry (hasSchemaRegistryOrOAuth)
        ToolName.LIST_SCHEMAS,
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
        // Schema Registry (hasSchemaRegistry — delete-schema not yet OAuth-migrated)
        ToolName.DELETE_SCHEMA,
        // Catalog / search (hasCCloudCatalogSupport — needs the schema_registry block)
        ToolName.SEARCH_TOPICS_BY_TAG,
        ToolName.SEARCH_TOPICS_BY_NAME,
        ToolName.CREATE_TOPIC_TAGS,
        ToolName.DELETE_TAG,
        ToolName.REMOVE_TAG_FROM_ENTITY,
        ToolName.ADD_TAGS_TO_TOPIC,
        ToolName.LIST_TAGS,
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
});
