import { DirectClientManager } from "@src/confluent/direct-client-manager.js";
import {
  CREATE_UPDATE,
  DESTRUCTIVE,
  READ_ONLY,
} from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ToolHandlerRegistry } from "@src/confluent/tools/tool-registry.js";
import { initEnv } from "@src/env.js";
import {
  DEFAULT_CONNECTION_ID,
  runtimeWith,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  stubClientGetters,
  type HandleOutcome,
} from "@tests/stubs/index.js";
import { beforeAll, describe, expect, it, type Mocked } from "vitest";

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
  });

  describe("handle() smoke tests", () => {
    /**
     * Builds a `ServerRuntime` with every service block populated, injecting
     * `clientManager` so callers can verify which client getters were invoked.
     */
    function allServicesRuntime(clientManager: Mocked<DirectClientManager>) {
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
     * What each handler produces when called with no arguments against a
     * fully-wired universal client. Use `{ resolves }` when the handler
     * completes and `{ throws }` when it raises before returning.
     * Use `"DISCOVER"` as a placeholder — the smoke test will run the handler
     * and report the correct entry to paste in.
     */
    const ZERO_ARG_OUTCOMES: Partial<Record<ToolName, HandleOutcome>> = {
      // Kafka
      [ToolName.LIST_TOPICS]: { resolves: "Kafka topics:" },
      [ToolName.CREATE_TOPICS]: { throws: "ZodError" },
      [ToolName.DELETE_TOPICS]: { throws: "ZodError" },
      [ToolName.PRODUCE_MESSAGE]: { throws: "ZodError" },
      [ToolName.CONSUME_MESSAGES]: { throws: "ZodError" },
      [ToolName.ALTER_TOPIC_CONFIG]: { throws: "ZodError" },
      [ToolName.GET_TOPIC_CONFIG]: { throws: "ZodError" },
      // Schema Registry
      [ToolName.LIST_SCHEMAS]: { resolves: "{}" },
      [ToolName.DELETE_SCHEMA]: { throws: "ZodError" },
      // Flink
      [ToolName.LIST_FLINK_STATEMENTS]: {
        throws: "Organization ID is required",
      },
      [ToolName.CREATE_FLINK_STATEMENT]: { throws: "ZodError" },
      [ToolName.READ_FLINK_STATEMENT]: { throws: "ZodError" },
      [ToolName.DELETE_FLINK_STATEMENTS]: { throws: "ZodError" },
      [ToolName.GET_FLINK_STATEMENT_EXCEPTIONS]: { throws: "ZodError" },
      [ToolName.CHECK_FLINK_STATEMENT_HEALTH]: { throws: "ZodError" },
      [ToolName.DETECT_FLINK_STATEMENT_ISSUES]: { throws: "ZodError" },
      [ToolName.GET_FLINK_STATEMENT_PROFILE]: { throws: "ZodError" },
      [ToolName.LIST_FLINK_CATALOGS]: { throws: "Organization ID is required" },
      [ToolName.LIST_FLINK_DATABASES]: {
        throws: "Organization ID is required",
      },
      [ToolName.LIST_FLINK_TABLES]: { throws: "Organization ID is required" },
      [ToolName.DESCRIBE_FLINK_TABLE]: { throws: "ZodError" },
      [ToolName.GET_FLINK_TABLE_INFO]: { throws: "ZodError" },
      // Connect
      [ToolName.LIST_CONNECTORS]: { throws: "Environment ID is required" },
      [ToolName.READ_CONNECTOR]: { throws: "ZodError" },
      [ToolName.CREATE_CONNECTOR]: { throws: "ZodError" },
      [ToolName.DELETE_CONNECTOR]: { throws: "ZodError" },
      // Catalog
      [ToolName.CREATE_TOPIC_TAGS]: { throws: "ZodError" },
      [ToolName.DELETE_TAG]: { throws: "ZodError" },
      [ToolName.REMOVE_TAG_FROM_ENTITY]: { throws: "ZodError" },
      [ToolName.ADD_TAGS_TO_TOPIC]: { throws: "ZodError" },
      [ToolName.LIST_TAGS]: { resolves: "Successfully retrieved tags" },
      // Search
      [ToolName.SEARCH_TOPICS_BY_TAG]: { resolves: "{}" },
      [ToolName.SEARCH_TOPICS_BY_NAME]: { throws: "ZodError" },
      // Environments
      [ToolName.LIST_ENVIRONMENTS]: {
        responseData: {
          api_version: "org/v2",
          kind: "EnvironmentList",
          data: [],
        },
        resolves: "Successfully retrieved 0 environments",
      },
      [ToolName.READ_ENVIRONMENT]: { throws: "ZodError" },
      // Clusters
      [ToolName.LIST_CLUSTERS]: {
        responseData: { data: [] },
        resolves: "Successfully retrieved 0 clusters",
      },
      // Tableflow
      [ToolName.CREATE_TABLEFLOW_TOPIC]: { throws: "ZodError" },
      [ToolName.LIST_TABLEFLOW_REGIONS]: { resolves: "Tableflow Regions" },
      [ToolName.LIST_TABLEFLOW_TOPICS]: {
        throws: "Environment ID is required",
      },
      [ToolName.READ_TABLEFLOW_TOPIC]: { throws: "ZodError" },
      [ToolName.UPDATE_TABLEFLOW_TOPIC]: { throws: "ZodError" },
      [ToolName.DELETE_TABLEFLOW_TOPIC]: { throws: "ZodError" },
      [ToolName.CREATE_TABLEFLOW_CATALOG_INTEGRATION]: { throws: "ZodError" },
      [ToolName.LIST_TABLEFLOW_CATALOG_INTEGRATIONS]: {
        throws: "Environment ID is required",
      },
      [ToolName.READ_TABLEFLOW_CATALOG_INTEGRATION]: { throws: "ZodError" },
      [ToolName.UPDATE_TABLEFLOW_CATALOG_INTEGRATION]: { throws: "ZodError" },
      [ToolName.DELETE_TABLEFLOW_CATALOG_INTEGRATION]: { throws: "ZodError" },
      // Billing
      [ToolName.LIST_BILLING_COSTS]: { throws: "ZodError" },
      // Metrics
      [ToolName.QUERY_METRICS]: { throws: "ZodError" },
      [ToolName.LIST_METRICS]: {
        responseData: { data: [] },
        resolves: "No metrics descriptors available",
      },
      // Documentation
      [ToolName.SEARCH_PRODUCT_DOCS]: { throws: "ZodError" },
      // Organizations
      [ToolName.LIST_ORGANIZATIONS]: {
        responseData: {
          api_version: "org/v2",
          kind: "OrganizationList",
          data: [],
        },
        resolves: "Retrieved 0 organizations",
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

    it.each(Object.entries(ZERO_ARG_OUTCOMES) as [ToolName, HandleOutcome][])(
      "%s: handle() should not crash before reaching the ClientManager",
      async (name, outcome) => {
        const responseData =
          typeof outcome === "object" && "responseData" in outcome
            ? outcome.responseData
            : undefined;
        const { clientManager, clientGetters } =
          stubClientGetters(responseData);
        await assertHandleCase({
          handler: ToolHandlerRegistry.getToolHandler(name),
          runtime: allServicesRuntime(clientManager),
          args: {},
          outcome,
          clientGetters,
          name,
        });
      },
    );
  });
});
