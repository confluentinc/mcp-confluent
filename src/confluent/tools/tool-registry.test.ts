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
  hasCCloudCatalogOrOAuth,
  hasConfluentCloudOrOAuth,
  hasFlink,
  hasSchemaRegistryOrOAuth,
  hasTableflowOrOAuth,
  hasTelemetryOrOAuth,
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
  getMockedRestClient,
  type HandleOutcome,
  type MockedClientManager,
} from "@tests/stubs/index.js";
import { beforeAll, describe, expect, it } from "vitest";

const ALL_TOOL_NAMES = Object.values(ToolName);

// Reverse map from enum value ("list-topics") → enum key ("LIST_TOPICS"),
// used to generate copy-paste suggestions in failure messages.
const TOOL_NAME_TO_KEY = Object.fromEntries(
  Object.entries(ToolName).map(([k, v]) => [v, k]),
) as Record<ToolName, string>;

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
          const config = handler.getRegisteredToolConfig(runtimeWith());

          expect(config.name).toBe(name);
          expect(config.description.length).toBeGreaterThan(10);
          expect(config.inputSchema).toBeDefined();
        }
      });

      it("should have a valid annotation (READ_ONLY, CREATE_UPDATE, or DESTRUCTIVE) for every tool", () => {
        for (const name of ALL_TOOL_NAMES) {
          const handler = ToolHandlerRegistry.getToolHandler(name);
          const config = handler.getRegisteredToolConfig(runtimeWith());

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

      it("should annotate every connection-agnostic (alwaysEnabled) tool as READ_ONLY so the read-only overlay is a no-op for them", () => {
        // The read-only verdict overlay disables a tool on a read_only
        // connection only when its readOnlyHint !== true. Connection-agnostic
        // tools take no connectionId and so should never be suppressed by a
        // connection's read_only flag; this holds for free precisely because
        // every alwaysEnabled tool is READ_ONLY. Pinning it here means the
        // overlay needs no special-case for the alwaysEnabled set — if a future
        // mutating tool is wired to alwaysEnabled, this fails instead.
        for (const name of ALL_TOOL_NAMES) {
          const handler = ToolHandlerRegistry.getToolHandler(name);
          if (handler.predicate !== alwaysEnabled) continue;
          const config = handler.getRegisteredToolConfig(runtimeWith());
          expect(
            config.annotations,
            `Connection-agnostic tool ${name} must be READ_ONLY`,
          ).toBe(READ_ONLY);
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
          "explain",
          "check",
          "detect",
          "query",
          "consume",
          "config",
        ]);
        const createUpdatePrefixes = new Set([
          "create",
          "produce",
          "add",
          "update",
          "alter",
          "pause",
          "resume",
          "restart",
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
          const config = handler.getRegisteredToolConfig(runtimeWith());

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
      // Exhaustive mapping of every registered tool to the named export
      // from connection-predicates.ts that its handler is expected to wire
      // as its `predicate`.
      //
      // When adding a new tool or rewiring an existing one: edit a single
      // entry. The `it.each` row label names the offending tool if a
      // handler's `predicate` drifts from the table.
      const EXPECTED_PREDICATES: Readonly<
        Record<ToolName, ConnectionPredicate>
      > = {
        // Kafka
        [ToolName.LIST_TOPICS]: kafkaBootstrapOrOAuth,
        [ToolName.CREATE_TOPICS]: kafkaBootstrapOrOAuth,
        [ToolName.DELETE_TOPICS]: kafkaBootstrapOrOAuth,
        [ToolName.PRODUCE_MESSAGE]: kafkaBootstrapOrOAuth,
        [ToolName.CONSUME_MESSAGES]: kafkaBootstrapOrOAuth,
        [ToolName.GET_PARTITION_OFFSETS]: kafkaBootstrapOrOAuth,
        [ToolName.LIST_CONSUMER_GROUPS]: kafkaBootstrapOrOAuth,
        [ToolName.DESCRIBE_CONSUMER_GROUP]: kafkaBootstrapOrOAuth,
        [ToolName.GET_CONSUMER_GROUP_LAG]: kafkaBootstrapOrOAuth,
        [ToolName.ALTER_TOPIC_CONFIG]: kafkaRestWithAuthOrOAuth,
        [ToolName.GET_TOPIC_CONFIG]: kafkaRestWithAuthOrOAuth,
        // Flink
        [ToolName.LIST_FLINK_STATEMENTS]: hasFlink,
        [ToolName.CREATE_FLINK_STATEMENT]: hasFlink,
        [ToolName.GET_FLINK_STATEMENT_RESULTS]: hasFlink,
        [ToolName.DELETE_FLINK_STATEMENTS]: hasFlink,
        [ToolName.GET_FLINK_STATEMENT_EXCEPTIONS]: hasFlink,
        [ToolName.LIST_FLINK_CATALOGS]: hasFlink,
        [ToolName.LIST_FLINK_DATABASES]: hasFlink,
        [ToolName.LIST_FLINK_TABLES]: hasFlink,
        [ToolName.DESCRIBE_FLINK_TABLE]: hasFlink,
        [ToolName.GET_FLINK_TABLE_INFO]: hasFlink,
        [ToolName.CHECK_FLINK_STATEMENT_HEALTH]: hasFlink,
        [ToolName.DETECT_FLINK_STATEMENT_ISSUES]: hasFlink,
        [ToolName.GET_FLINK_STATEMENT_PROFILE]: flinkWithTelemetry,
        // Connect — OAuth-capable (ride the cloud REST client); create-connector
        // stays direct-only (embeds a Kafka API key/secret in the connector spec).
        [ToolName.LIST_CONNECTORS]: hasConfluentCloudOrOAuth,
        [ToolName.GET_CONNECTOR_CONFIG]: hasConfluentCloudOrOAuth,
        [ToolName.GET_CONNECTOR_OFFSETS]: hasConfluentCloudOrOAuth,
        [ToolName.GET_CONNECTOR_STATUS]: hasConfluentCloudOrOAuth,
        [ToolName.GET_CONNECTOR_TASKS]: hasConfluentCloudOrOAuth,
        [ToolName.CREATE_CONNECTOR]: canCreateDirectConnector,
        [ToolName.DELETE_CONNECTOR]: hasConfluentCloudOrOAuth,
        [ToolName.GET_CONNECTOR_ERROR_SUMMARY]: hasConfluentCloudOrOAuth,
        [ToolName.GET_CONNECTOR_ERROR_RECOMMENDATIONS]:
          hasConfluentCloudOrOAuth,
        [ToolName.GET_CONNECTOR_LOGS]: hasConfluentCloudOrOAuth,
        [ToolName.PAUSE_CONNECTOR]: hasConfluentCloudOrOAuth,
        [ToolName.RESUME_CONNECTOR]: hasConfluentCloudOrOAuth,
        [ToolName.RESTART_CONNECTOR]: hasConfluentCloudOrOAuth,
        [ToolName.UPDATE_CONNECTOR_CONFIG]: hasConfluentCloudOrOAuth,
        // Catalog + search (CCloud catalog support, widened for OAuth)
        [ToolName.SEARCH_TOPICS_BY_TAG]: hasCCloudCatalogOrOAuth,
        [ToolName.SEARCH_TOPICS_BY_NAME]: hasCCloudCatalogOrOAuth,
        [ToolName.CREATE_TOPIC_TAGS]: hasCCloudCatalogOrOAuth,
        [ToolName.DELETE_TAG]: hasCCloudCatalogOrOAuth,
        [ToolName.REMOVE_TAG_FROM_ENTITY]: hasCCloudCatalogOrOAuth,
        [ToolName.ADD_TAGS_TO_TOPIC]: hasCCloudCatalogOrOAuth,
        [ToolName.LIST_TAGS]: hasCCloudCatalogOrOAuth,
        // Clusters
        [ToolName.LIST_CLUSTERS]: hasConfluentCloudOrOAuth,
        // Environments + billing + organizations (Confluent Cloud control plane)
        [ToolName.LIST_ENVIRONMENTS]: hasConfluentCloudOrOAuth,
        [ToolName.READ_ENVIRONMENT]: hasConfluentCloudOrOAuth,
        [ToolName.LIST_BILLING_COSTS]: hasConfluentCloudOrOAuth,
        [ToolName.LIST_ORGANIZATIONS]: hasConfluentCloudOrOAuth,
        // Schema Registry
        [ToolName.LIST_SCHEMAS]: hasSchemaRegistryOrOAuth,
        [ToolName.CREATE_SCHEMA]: hasSchemaRegistryOrOAuth,
        [ToolName.DELETE_SCHEMA]: hasSchemaRegistryOrOAuth,
        // Tableflow
        [ToolName.CREATE_TABLEFLOW_TOPIC]: hasTableflowOrOAuth,
        [ToolName.LIST_TABLEFLOW_REGIONS]: hasTableflowOrOAuth,
        [ToolName.LIST_TABLEFLOW_TOPICS]: hasTableflowOrOAuth,
        [ToolName.READ_TABLEFLOW_TOPIC]: hasTableflowOrOAuth,
        [ToolName.UPDATE_TABLEFLOW_TOPIC]: hasTableflowOrOAuth,
        [ToolName.DELETE_TABLEFLOW_TOPIC]: hasTableflowOrOAuth,
        [ToolName.CREATE_TABLEFLOW_CATALOG_INTEGRATION]: hasTableflowOrOAuth,
        [ToolName.LIST_TABLEFLOW_CATALOG_INTEGRATIONS]: hasTableflowOrOAuth,
        [ToolName.READ_TABLEFLOW_CATALOG_INTEGRATION]: hasTableflowOrOAuth,
        [ToolName.UPDATE_TABLEFLOW_CATALOG_INTEGRATION]: hasTableflowOrOAuth,
        [ToolName.DELETE_TABLEFLOW_CATALOG_INTEGRATION]: hasTableflowOrOAuth,
        // Metrics (Telemetry API)
        [ToolName.QUERY_METRICS]: hasTelemetryOrOAuth,
        [ToolName.LIST_METRICS]: hasTelemetryOrOAuth,
        // Documentation (no service-block requirement)
        [ToolName.SEARCH_PRODUCT_DOCS]: alwaysEnabled,
        [ToolName.GET_PRODUCT_DOC_PAGE]: alwaysEnabled,
        // Diagnostics (no service-block requirement)
        [ToolName.EXPLAIN_DISABLED_TOOLS]: alwaysEnabled,
        [ToolName.LIST_CONFIGURED_CONNECTIONS]: alwaysEnabled,
        [ToolName.CONFIG_HELP]: alwaysEnabled,
        [ToolName.DESCRIBE_CONFIGURED_CONNECTION]: alwaysEnabled,
      };

      it.each(
        Object.entries(EXPECTED_PREDICATES) as [
          ToolName,
          ConnectionPredicate,
        ][],
      )(
        "%s: handler.predicate must be exactly the expected named export",
        (toolName, expectedPredicate) => {
          const handler = ToolHandlerRegistry.getToolHandler(toolName);
          // Every registered handler is expected to extend BaseToolHandler —
          // that's where the `predicate` property lives. The instanceof check
          // both narrows the type for the next assertion and enforces the
          // class-extension invariant in its own right.
          expect(
            handler,
            `Tool ${toolName}'s handler does not extend BaseToolHandler; ` +
              `the predicate property lives on BaseToolHandler.`,
          ).toBeInstanceOf(BaseToolHandler);
          expect(
            (handler as BaseToolHandler).predicate,
            `Tool ${toolName}'s handler.predicate does not match the value ` +
              `in EXPECTED_PREDICATES. Either: (1) the handler is wired to ` +
              `the wrong predicate (or composes inline with allOf(...) / ` +
              `widenForOAuth(...) at the use site — promote to a named const ` +
              `export and reference it instead); or (2) the handler was ` +
              `deliberately rewired and EXPECTED_PREDICATES needs updating.`,
          ).toBe(expectedPredicate);
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
      /** Set for handlers that legitimately resolve without touching the
       *  client layer (e.g. meta/diagnostic tools that read the registry
       *  rather than calling Confluent Cloud). Skips the
       *  "must have called a client getter" assertion in `assertHandleCase`. */
      bypassesClientLayer?: boolean;
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
      [ToolName.LIST_CONSUMER_GROUPS]: {
        outcome: { resolves: "Found 0 consumer group" },
        setup: async (cm) => {
          (await cm.getAdminClient()).listGroups.mockResolvedValue({
            groups: [],
            errors: [],
          });
        },
      },
      [ToolName.DESCRIBE_CONSUMER_GROUP]: { outcome: { throws: "ZodError" } },
      [ToolName.GET_CONSUMER_GROUP_LAG]: { outcome: { throws: "ZodError" } },
      [ToolName.CREATE_TOPICS]: { outcome: { throws: "ZodError" } },
      [ToolName.DELETE_TOPICS]: { outcome: { throws: "ZodError" } },
      [ToolName.PRODUCE_MESSAGE]: { outcome: { throws: "ZodError" } },
      [ToolName.CONSUME_MESSAGES]: { outcome: { throws: "ZodError" } },
      [ToolName.GET_PARTITION_OFFSETS]: { outcome: { throws: "ZodError" } },
      [ToolName.ALTER_TOPIC_CONFIG]: { outcome: { throws: "ZodError" } },
      [ToolName.GET_TOPIC_CONFIG]: { outcome: { throws: "ZodError" } },
      // Schema Registry
      [ToolName.LIST_SCHEMAS]: {
        outcome: { resolves: "{}" },
        setup: (cm) => {
          cm.getSchemaRegistryClient().getAllSubjects.mockResolvedValue([]);
        },
      },
      [ToolName.CREATE_SCHEMA]: { outcome: { throws: "ZodError" } },
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
      [ToolName.GET_FLINK_STATEMENT_RESULTS]: {
        outcome: { throws: "ZodError" },
      },
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
      [ToolName.GET_CONNECTOR_CONFIG]: { outcome: { throws: "ZodError" } },
      [ToolName.GET_CONNECTOR_OFFSETS]: { outcome: { throws: "ZodError" } },
      [ToolName.GET_CONNECTOR_STATUS]: { outcome: { throws: "ZodError" } },
      [ToolName.GET_CONNECTOR_TASKS]: { outcome: { throws: "ZodError" } },
      [ToolName.CREATE_CONNECTOR]: { outcome: { throws: "ZodError" } },
      [ToolName.DELETE_CONNECTOR]: { outcome: { throws: "ZodError" } },
      [ToolName.GET_CONNECTOR_ERROR_SUMMARY]: {
        outcome: { throws: "ZodError" },
      },
      [ToolName.GET_CONNECTOR_ERROR_RECOMMENDATIONS]: {
        outcome: { throws: "ZodError" },
      },
      [ToolName.GET_CONNECTOR_LOGS]: { outcome: { throws: "ZodError" } },
      [ToolName.PAUSE_CONNECTOR]: { outcome: { throws: "ZodError" } },
      [ToolName.RESUME_CONNECTOR]: { outcome: { throws: "ZodError" } },
      [ToolName.RESTART_CONNECTOR]: { outcome: { throws: "ZodError" } },
      [ToolName.UPDATE_CONNECTOR_CONFIG]: { outcome: { throws: "ZodError" } },
      // Catalog
      [ToolName.CREATE_TOPIC_TAGS]: { outcome: { throws: "ZodError" } },
      [ToolName.DELETE_TAG]: { outcome: { throws: "ZodError" } },
      [ToolName.REMOVE_TAG_FROM_ENTITY]: { outcome: { throws: "ZodError" } },
      [ToolName.ADD_TAGS_TO_TOPIC]: { outcome: { throws: "ZodError" } },
      [ToolName.LIST_TAGS]: {
        outcome: { resolves: "Successfully retrieved tags" },
        setup: (cm) => {
          const sr = getMockedRestClient();
          sr.GET.mockResolvedValue({ data: [] });
          cm.getSchemaRegistryRestClient.mockResolvedValue(sr);
        },
      },
      // Search
      [ToolName.SEARCH_TOPICS_BY_TAG]: {
        outcome: { resolves: "{}" },
        setup: (cm) => {
          const sr = getMockedRestClient();
          sr.GET.mockResolvedValue({ data: {} });
          cm.getSchemaRegistryRestClient.mockResolvedValue(sr);
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
        // resolveEnvArg throws under direct when neither environmentId arg
        // nor conn.kafka.env_id supplies a value — `allServicesRuntime`
        // omits kafka.env_id, so this is the expected smoke-test path.
        outcome: { throws: "environmentId is required" },
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
      // Diagnostics — no client calls; the handler walks the registry's
      // own predicate map. Against `allServicesRuntime` every gate passes
      // and the handler emits its all-advertised summary.
      [ToolName.EXPLAIN_DISABLED_TOOLS]: {
        outcome: { resolves: "registered tools are advertised via tools/list" },
        bypassesClientLayer: true,
      },
      // list-configured-connections also walks the registry's predicate map rather than
      // any client; against the single-connection smoke runtime it emits its
      // connection-count header.
      [ToolName.LIST_CONFIGURED_CONNECTIONS]: {
        outcome: { resolves: "1 connection configured:" },
        bypassesClientLayer: true,
      },
      // config-help requires a `tool` arg; zero args fails Zod parse before
      // it ever reaches the registry walk or any client.
      [ToolName.CONFIG_HELP]: {
        outcome: { throws: "ZodError" },
        bypassesClientLayer: true,
      },
      // describe-configured-connection requires a connectionId argument, so the
      // zero-arg smoke call trips its Zod schema before touching any client.
      [ToolName.DESCRIBE_CONFIGURED_CONNECTION]: {
        outcome: { throws: "ZodError" },
        bypassesClientLayer: true,
      },
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
          // Pass clientManager only when the handler exercises the client
          // layer; meta/diagnostic tools that read the registry instead are
          // exempt from the "must have called a client getter" assertion.
          clientManager: fixture.bypassesClientLayer
            ? undefined
            : clientManager,
          name,
        });
      },
    );
  });
});
