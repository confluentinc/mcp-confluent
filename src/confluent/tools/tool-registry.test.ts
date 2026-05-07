import {
  BaseToolHandler,
  CREATE_UPDATE,
  DESTRUCTIVE,
  READ_ONLY,
} from "@src/confluent/tools/base-tools.js";
import {
  alwaysEnabled,
  canCreateDirectConnector,
  type ConnectionPredicate,
  flinkWithTelemetry,
  hasCCloudCatalogSupport,
  hasConfluentCloud,
  hasDirectConfluentCloud,
  hasFlink,
  hasKafka,
  hasKafkaAuth,
  hasKafkaBootstrap,
  hasKafkaRestWithAuth,
  hasSchemaRegistry,
  hasTableflow,
  hasTelemetry,
  kafkaBootstrapOrOAuth,
  kafkaRestWithAuthOrOAuth,
} from "@src/confluent/tools/connection-predicates.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ToolHandlerRegistry } from "@src/confluent/tools/tool-registry.js";
import { initEnv } from "@src/env.js";
import {
  DEFAULT_CONNECTION_ID,
  runtimeWith,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  getMockedClientManager,
  type HandleOutcome,
  type MockedClientManager,
} from "@tests/stubs/index.js";
import { beforeAll, describe, expect, it } from "vitest";

const ALL_TOOL_NAMES = Object.values(ToolName);

describe("tool-registry.ts", () => {
  describe("ToolHandlerRegistry", () => {
    describe("getToolHandler()", () => {
      it("should have a handler for every tool", () => {
        for (const name of ALL_TOOL_NAMES) {
          expect(() => ToolHandlerRegistry.getToolHandler(name)).not.toThrow();
        }
      });

      it("should return valid ToolConfig for every registered tool", () => {
        for (const name of ALL_TOOL_NAMES) {
          const handler = ToolHandlerRegistry.getToolHandler(name);
          const config = handler.getToolConfig();

          expect(config.name).toBe(name);
          expect(config.description.length).toBeGreaterThan(10);
          expect(config.inputSchema).toBeDefined();
        }
      });

      it("should have a valid annotation (READ_ONLY, CREATE_UPDATE, or DESTRUCTIVE) for every tool", () => {
        for (const name of ALL_TOOL_NAMES) {
          const handler = ToolHandlerRegistry.getToolHandler(name);
          const config = handler.getToolConfig();

          expect(config.annotations).toBeDefined();

          const isValidAnnotation =
            config.annotations === READ_ONLY ||
            config.annotations === CREATE_UPDATE ||
            config.annotations === DESTRUCTIVE;

          expect(
            isValidAnnotation,
            `Tool ${name} must use one of: READ_ONLY, CREATE_UPDATE, or DESTRUCTIVE`,
          ).toBe(true);
        }
      });

      for (const name of ALL_TOOL_NAMES) {
        it(`${name}: should not implement getRequiredEnvVars() (deleted in issue-228)`, () => {
          const handler = ToolHandlerRegistry.getToolHandler(name);
          expect("getRequiredEnvVars" in handler).toBe(false);
        });

        it(`${name}: should not implement isConfluentCloudOnly() (deleted in issue-228)`, () => {
          const handler = ToolHandlerRegistry.getToolHandler(name);
          expect("isConfluentCloudOnly" in handler).toBe(false);
        });
      }

      it("should use annotations that match the tool name prefix convention", () => {
        const readOnlyPrefixes = new Set([
          "list",
          "read",
          "get",
          "search",
          "describe",
          "check",
          "detect",
          "query",
          "consume",
        ]);
        const createUpdatePrefixes = new Set([
          "create",
          "produce",
          "add",
          "update",
          "alter",
        ]);
        const destructivePrefixes = new Set(["delete", "remove"]);

        // Prove the three sets are disjoint (no overlapping elements)
        const allPrefixes = [
          ...readOnlyPrefixes,
          ...createUpdatePrefixes,
          ...destructivePrefixes,
        ];
        const uniquePrefixCount = new Set(allPrefixes).size;
        expect(
          uniquePrefixCount,
          "Prefix sets must be disjoint (no overlapping elements)",
        ).toBe(allPrefixes.length);

        for (const name of ALL_TOOL_NAMES) {
          const handler = ToolHandlerRegistry.getToolHandler(name);
          const config = handler.getToolConfig();

          const prefix = name.split("-")[0]!;

          if (readOnlyPrefixes.has(prefix)) {
            expect(
              config.annotations,
              `Tool ${name} with prefix "${prefix}" should use READ_ONLY`,
            ).toBe(READ_ONLY);
          } else if (createUpdatePrefixes.has(prefix)) {
            expect(
              config.annotations,
              `Tool ${name} with prefix "${prefix}" should use CREATE_UPDATE`,
            ).toBe(CREATE_UPDATE);
          } else if (destructivePrefixes.has(prefix)) {
            expect(
              config.annotations,
              `Tool ${name} with prefix "${prefix}" should use DESTRUCTIVE`,
            ).toBe(DESTRUCTIVE);
          } else {
            throw new Error(
              `Tool ${name} has unrecognized prefix "${prefix}" - add it to one of the prefix sets`,
            );
          }
        }
      });
    });

    describe("predicate property", () => {
      // The exhaustive allow-list of legal handler `predicate` values.
      const NAMED_PREDICATES: ReadonlySet<ConnectionPredicate> = new Set([
        alwaysEnabled,
        hasKafka,
        hasKafkaBootstrap,
        hasKafkaAuth,
        hasKafkaRestWithAuth,
        hasSchemaRegistry,
        hasConfluentCloud,
        hasDirectConfluentCloud,
        hasFlink,
        hasTelemetry,
        hasTableflow,
        hasCCloudCatalogSupport,
        kafkaBootstrapOrOAuth,
        kafkaRestWithAuthOrOAuth,
        canCreateDirectConnector,
        flinkWithTelemetry,
      ]);

      it.each(ALL_TOOL_NAMES)(
        "%s: predicate must be one of the expected predicates from connection-predicates.ts (no inline allOf/widenForOAuth at handler use sites)",
        (toolName) => {
          const handler = ToolHandlerRegistry.getToolHandler(toolName);
          // Every registered handler is expected to extend BaseToolHandler —
          // that's where the `predicate` property lives. The instanceof check
          // both narrows the type for the next assertion and enforces the
          // class-extension invariant in its own right.
          expect(
            handler,
            `Tool ${toolName}'s handler does not extend BaseToolHandler; the ` +
              `predicate property lives on BaseToolHandler, so a handler that ` +
              `implements ToolHandler directly cannot be checked for predicate ` +
              `compliance.`,
          ).toBeInstanceOf(BaseToolHandler);
          const predicate = (handler as BaseToolHandler).predicate;
          expect(
            NAMED_PREDICATES.has(predicate),
            `Tool ${toolName}'s predicate is not one of the named exports from ` +
              `connection-predicates.ts. Two possible causes: (1) the handler ` +
              `composes inline with allOf(...) or widenForOAuth(...) at the use ` +
              `site — promote the composition to a named const export (with a ` +
              `per-predicate test in connection-predicates.test.ts) and reference ` +
              `the named export here; or (2) you added a new predicate to ` +
              `connection-predicates.ts but forgot to add it to NAMED_PREDICATES ` +
              `in this test.`,
          ).toBe(true);
        },
      );
    });
  });

  describe("handle() smoke tests", () => {
    /**
     * Builds a `ServerRuntime` with every service block populated, injecting
     * `clientManager` so callers can verify which client getters were invoked.
     */
    function allServicesRuntime(clientManager: MockedClientManager) {
      return runtimeWith(
        {
          kafka: {
            bootstrap_servers: "broker:9092",
            rest_endpoint: "https://rest.example.com",
            auth: { type: "api_key", key: "k", secret: "s" },
          },
          flink: {
            endpoint: "https://flink.example.com",
            auth: { type: "api_key", key: "k", secret: "s" },
            environment_id: "env-1",
            organization_id: "org-1",
            compute_pool_id: "pool-1",
          },
          schema_registry: {
            endpoint: "https://sr.example.com",
            auth: { type: "api_key", key: "k", secret: "s" },
          },
          confluent_cloud: {
            endpoint: "https://api.confluent.cloud",
            auth: { type: "api_key", key: "k", secret: "s" },
          },
          tableflow: { auth: { type: "api_key", key: "k", secret: "s" } },
          telemetry: {
            endpoint: "https://telemetry.example.com",
            auth: { type: "api_key", key: "k", secret: "s" },
          },
        },
        DEFAULT_CONNECTION_ID,
        clientManager,
      );
    }

    // Reverse map from enum value ("list-topics") → enum key ("LIST_TOPICS"),
    // used to generate helpful copy-paste suggestions in failure messages.
    const TOOL_NAME_TO_KEY = Object.fromEntries(
      Object.entries(ToolName).map(([k, v]) => [v, k]),
    ) as Record<ToolName, string>;

    /**
     * Per-tool fixture: what each handler produces when called with no
     * arguments, plus an optional `setup` that mocks the specific client
     * method(s) the handler exercises. Tools that throw before reaching the
     * client layer (ZodError, missing-ID errors) need no `setup`. Tools that
     * resolve must `setup` whichever client they call so the bare `vi.fn()`
     * mocks returned by {@linkcode getMockedClientManager} produce a usable
     * response.
     *
     * Use `"DISCOVER"` as the outcome placeholder; the smoke test will run
     * the handler and report the correct entry to paste in.
     */
    type SmokeFixture = {
      outcome: HandleOutcome;
      setup?: (cm: MockedClientManager) => Promise<void> | void;
    };

    /** Stubs the Flink REST client to return a completed empty SQL query result.
     *  Shared by the catalog/database/table listing tools that all run a SQL
     *  query and stringify the empty result set. */
    function mockFlinkSqlEmpty(cm: MockedClientManager) {
      const flinkRest = cm.getConfluentCloudFlinkRestClient();
      const sqlResponse = {
        data: { status: { phase: "COMPLETED" }, results: { data: [] } },
      };
      flinkRest.POST.mockResolvedValue(sqlResponse);
      flinkRest.GET.mockResolvedValue(sqlResponse);
    }

    const ZERO_ARG_OUTCOMES: Partial<Record<ToolName, SmokeFixture>> = {
      // Kafka
      [ToolName.LIST_TOPICS]: {
        outcome: { resolves: "Kafka topics:" },
        setup: async (cm) => {
          (await cm.getAdminClient()).listTopics.mockResolvedValue([]);
        },
      },
      [ToolName.CREATE_TOPICS]: { outcome: { throws: "ZodError" } },
      [ToolName.DELETE_TOPICS]: { outcome: { throws: "ZodError" } },
      [ToolName.PRODUCE_MESSAGE]: { outcome: { throws: "ZodError" } },
      [ToolName.CONSUME_MESSAGES]: { outcome: { throws: "ZodError" } },
      [ToolName.ALTER_TOPIC_CONFIG]: { outcome: { throws: "ZodError" } },
      [ToolName.GET_TOPIC_CONFIG]: { outcome: { throws: "ZodError" } },
      // Schema Registry
      [ToolName.LIST_SCHEMAS]: {
        outcome: { resolves: "{}" },
        setup: (cm) => {
          cm.getSchemaRegistryClient().getAllSubjects.mockResolvedValue([]);
        },
      },
      [ToolName.DELETE_SCHEMA]: { outcome: { throws: "ZodError" } },
      // Flink
      [ToolName.LIST_FLINK_STATEMENTS]: {
        outcome: { resolves: "{}" },
        setup: (cm) => {
          cm.getConfluentCloudFlinkRestClient().GET.mockResolvedValue({
            data: {},
          });
        },
      },
      [ToolName.CREATE_FLINK_STATEMENT]: { outcome: { throws: "ZodError" } },
      [ToolName.READ_FLINK_STATEMENT]: { outcome: { throws: "ZodError" } },
      [ToolName.DELETE_FLINK_STATEMENTS]: { outcome: { throws: "ZodError" } },
      [ToolName.GET_FLINK_STATEMENT_EXCEPTIONS]: {
        outcome: { throws: "ZodError" },
      },
      [ToolName.CHECK_FLINK_STATEMENT_HEALTH]: {
        outcome: { throws: "ZodError" },
      },
      [ToolName.DETECT_FLINK_STATEMENT_ISSUES]: {
        outcome: { throws: "ZodError" },
      },
      [ToolName.GET_FLINK_STATEMENT_PROFILE]: {
        outcome: { throws: "ZodError" },
      },
      [ToolName.LIST_FLINK_CATALOGS]: {
        outcome: { resolves: "No catalogs found." },
        setup: mockFlinkSqlEmpty,
      },
      [ToolName.LIST_FLINK_DATABASES]: {
        outcome: { resolves: "No databases found." },
        setup: mockFlinkSqlEmpty,
      },
      [ToolName.LIST_FLINK_TABLES]: {
        outcome: { resolves: "No tables found in catalog" },
        setup: mockFlinkSqlEmpty,
      },
      [ToolName.DESCRIBE_FLINK_TABLE]: { outcome: { throws: "ZodError" } },
      [ToolName.GET_FLINK_TABLE_INFO]: { outcome: { throws: "ZodError" } },
      // Connect
      [ToolName.LIST_CONNECTORS]: {
        outcome: { throws: "Environment ID is required" },
      },
      [ToolName.READ_CONNECTOR]: { outcome: { throws: "ZodError" } },
      [ToolName.CREATE_CONNECTOR]: { outcome: { throws: "ZodError" } },
      [ToolName.DELETE_CONNECTOR]: { outcome: { throws: "ZodError" } },
      // Catalog
      [ToolName.CREATE_TOPIC_TAGS]: { outcome: { throws: "ZodError" } },
      [ToolName.DELETE_TAG]: { outcome: { throws: "ZodError" } },
      [ToolName.REMOVE_TAG_FROM_ENTITY]: { outcome: { throws: "ZodError" } },
      [ToolName.ADD_TAGS_TO_TOPIC]: { outcome: { throws: "ZodError" } },
      [ToolName.LIST_TAGS]: {
        outcome: { resolves: "Successfully retrieved tags" },
        setup: (cm) => {
          cm.getConfluentCloudSchemaRegistryRestClient().GET.mockResolvedValue({
            data: [],
          });
        },
      },
      // Search
      [ToolName.SEARCH_TOPICS_BY_TAG]: {
        outcome: { resolves: "{}" },
        setup: (cm) => {
          cm.getConfluentCloudSchemaRegistryRestClient().GET.mockResolvedValue({
            data: {},
          });
        },
      },
      [ToolName.SEARCH_TOPICS_BY_NAME]: { outcome: { throws: "ZodError" } },
      // Environments
      [ToolName.LIST_ENVIRONMENTS]: {
        outcome: { resolves: "Successfully retrieved 0 environments" },
        setup: (cm) => {
          cm.getConfluentCloudRestClient().GET.mockResolvedValue({
            data: {
              api_version: "org/v2",
              kind: "EnvironmentList",
              data: [],
            },
          });
        },
      },
      [ToolName.READ_ENVIRONMENT]: { outcome: { throws: "ZodError" } },
      // Clusters
      [ToolName.LIST_CLUSTERS]: {
        // Zero-arg invocation against a connection without kafka.env_id
        // short-circuits with an actionable error before reaching the
        // client (prevents a useless cmk round-trip + generic API error).
        outcome: {
          resolves:
            "environmentId is required: pass it as a tool argument or set kafka.env_id",
        },
      },
      // Tableflow
      [ToolName.CREATE_TABLEFLOW_TOPIC]: { outcome: { throws: "ZodError" } },
      [ToolName.LIST_TABLEFLOW_REGIONS]: {
        outcome: { resolves: "Tableflow Regions" },
        setup: (cm) => {
          cm.getConfluentCloudTableflowRestClient().GET.mockResolvedValue({
            data: { data: [] },
          });
        },
      },
      [ToolName.LIST_TABLEFLOW_TOPICS]: {
        outcome: { throws: "Environment ID is required" },
      },
      [ToolName.READ_TABLEFLOW_TOPIC]: { outcome: { throws: "ZodError" } },
      [ToolName.UPDATE_TABLEFLOW_TOPIC]: { outcome: { throws: "ZodError" } },
      [ToolName.DELETE_TABLEFLOW_TOPIC]: { outcome: { throws: "ZodError" } },
      [ToolName.CREATE_TABLEFLOW_CATALOG_INTEGRATION]: {
        outcome: { throws: "ZodError" },
      },
      [ToolName.LIST_TABLEFLOW_CATALOG_INTEGRATIONS]: {
        outcome: { throws: "Environment ID is required" },
      },
      [ToolName.READ_TABLEFLOW_CATALOG_INTEGRATION]: {
        outcome: { throws: "ZodError" },
      },
      [ToolName.UPDATE_TABLEFLOW_CATALOG_INTEGRATION]: {
        outcome: { throws: "ZodError" },
      },
      [ToolName.DELETE_TABLEFLOW_CATALOG_INTEGRATION]: {
        outcome: { throws: "ZodError" },
      },
      // Billing
      [ToolName.LIST_BILLING_COSTS]: { outcome: { throws: "ZodError" } },
      // Metrics
      [ToolName.QUERY_METRICS]: { outcome: { throws: "ZodError" } },
      [ToolName.LIST_METRICS]: {
        outcome: { resolves: "No metrics descriptors available" },
        setup: (cm) => {
          cm.getConfluentCloudTelemetryRestClient().GET.mockResolvedValue({
            data: { data: [] },
          });
        },
      },
      // Documentation
      [ToolName.SEARCH_PRODUCT_DOCS]: { outcome: { throws: "ZodError" } },
      [ToolName.GET_PRODUCT_DOC_PAGE]: { outcome: { throws: "ZodError" } },
      // Organizations
      [ToolName.LIST_ORGANIZATIONS]: {
        outcome: { resolves: "Retrieved 0 organizations" },
        setup: (cm) => {
          cm.getConfluentCloudRestClient().GET.mockResolvedValue({
            data: {
              api_version: "org/v2",
              kind: "OrganizationList",
              data: [],
            },
          });
        },
      },
    };

    beforeAll(() => {
      initEnv();
    });

    // One test per tool — each missing entry is its own failure with a copy-paste fix.
    it.each(ALL_TOOL_NAMES)(
      "%s: should have an entry in ZERO_ARG_OUTCOMES",
      (name) => {
        expect(
          name in ZERO_ARG_OUTCOMES,
          `Add [ToolName.${TOOL_NAME_TO_KEY[name]}]: "DISCOVER" to ZERO_ARG_OUTCOMES, ` +
            `then run: npm test -- src/confluent/tools/tool-registry.test.ts`,
        ).toBe(true);
      },
    );

    it.each(Object.entries(ZERO_ARG_OUTCOMES) as [ToolName, SmokeFixture][])(
      "%s: handle() should not crash before reaching the ClientManager",
      async (name, fixture) => {
        const clientManager = getMockedClientManager();
        await fixture.setup?.(clientManager);
        await assertHandleCase({
          handler: ToolHandlerRegistry.getToolHandler(name),
          runtime: allServicesRuntime(clientManager),
          args: {},
          outcome: fixture.outcome,
          clientManager,
          name,
        });
      },
    );
  });
});
