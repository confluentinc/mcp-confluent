import { DefaultClientManager } from "@src/confluent/client-manager.js";
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
import { createMockInstance } from "@tests/stubs/index.js";
import { type Mocked, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";

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
    function allServicesRuntime(clientManager: Mocked<DefaultClientManager>) {
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
     * Wires every client getter on a fresh `Mocked<DefaultClientManager>` to a
     * recursive Proxy: any property access or call on the returned client resolves
     * to another instance of the same Proxy, so handler bodies never throw a
     * TypeError before they reach real logic. A TypeError that escapes is therefore
     * a genuine wiring failure — exactly what the smoke tests check for.
     *
     * Returns `{ clientManager, clientGetters }`. `clientGetters` is the canonical
     * list of all getter mocks; callers use it to assert that at least one was
     * invoked when a handler resolves successfully.
     */
    function stubClientGetters() {
      const proxy = new Proxy(() => Promise.resolve(proxy), {
        get: (_t, prop) => {
          if (prop === "then") return undefined;
          return () => Promise.resolve(proxy);
        },
        apply: () => Promise.resolve(proxy),
      });
      const clientManager = createMockInstance(DefaultClientManager);
      clientManager.getAdminClient.mockResolvedValue(proxy as never);
      clientManager.getProducer.mockResolvedValue(proxy as never);
      clientManager.getConsumer.mockResolvedValue(proxy as never);
      clientManager.getConfluentCloudFlinkRestClient.mockReturnValue(
        proxy as never,
      );
      clientManager.getConfluentCloudRestClient.mockReturnValue(proxy as never);
      clientManager.getConfluentCloudTableflowRestClient.mockReturnValue(
        proxy as never,
      );
      clientManager.getConfluentCloudSchemaRegistryRestClient.mockReturnValue(
        proxy as never,
      );
      clientManager.getConfluentCloudKafkaRestClient.mockReturnValue(
        proxy as never,
      );
      clientManager.getConfluentCloudTelemetryRestClient.mockReturnValue(
        proxy as never,
      );
      clientManager.getSchemaRegistryClient.mockReturnValue(proxy as never);
      const clientGetters = [
        clientManager.getAdminClient,
        clientManager.getProducer,
        clientManager.getConsumer,
        clientManager.getConfluentCloudFlinkRestClient,
        clientManager.getConfluentCloudRestClient,
        clientManager.getConfluentCloudTableflowRestClient,
        clientManager.getConfluentCloudSchemaRegistryRestClient,
        clientManager.getConfluentCloudKafkaRestClient,
        clientManager.getConfluentCloudTelemetryRestClient,
        clientManager.getSchemaRegistryClient,
      ];
      return { clientManager, clientGetters };
    }

    /** Handler resolves: response text contains `resolves`. */
    type Resolves = { resolves: string };
    /** Handler throws: "ZodError" or error message contains `throws`. */
    type Throws = { throws: string };
    type ZeroArgOutcome = Resolves | Throws;

    /**
     * What each handler produces when called with no arguments against a
     * fully-wired universal client. Use `{ resolves }` when the handler
     * completes and `{ throws }` when it raises before returning.
     */
    const ZERO_ARG_OUTCOMES: Record<ToolName, ZeroArgOutcome> = {
      // Kafka
      [ToolName.LIST_TOPICS]: { resolves: "Kafka topics:" },
      [ToolName.CREATE_TOPICS]: { throws: "ZodError" },
      [ToolName.DELETE_TOPICS]: { throws: "ZodError" },
      [ToolName.PRODUCE_MESSAGE]: { throws: "ZodError" },
      [ToolName.CONSUME_MESSAGES]: { throws: "ZodError" },
      [ToolName.ALTER_TOPIC_CONFIG]: { throws: "ZodError" },
      [ToolName.GET_TOPIC_CONFIG]: { throws: "ZodError" },
      // Schema Registry
      [ToolName.LIST_SCHEMAS]: { resolves: "Failed to list schemas" },
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
      [ToolName.LIST_TAGS]: { resolves: "Failed to list tags" },
      // Search
      [ToolName.SEARCH_TOPICS_BY_TAG]: {
        resolves: "Failed to search for topics by tag",
      },
      [ToolName.SEARCH_TOPICS_BY_NAME]: { throws: "ZodError" },
      // Environments
      [ToolName.LIST_ENVIRONMENTS]: {
        resolves: "Failed to fetch environments",
      },
      [ToolName.READ_ENVIRONMENT]: { throws: "ZodError" },
      // Clusters
      [ToolName.LIST_CLUSTERS]: { resolves: "Failed to fetch clusters" },
      // Tableflow
      [ToolName.CREATE_TABLEFLOW_TOPIC]: { throws: "ZodError" },
      [ToolName.LIST_TABLEFLOW_REGIONS]: {
        resolves: "Failed to list Tableflow regions",
      },
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
      [ToolName.LIST_METRICS]: { resolves: "No metrics descriptors available" },
    };

    beforeAll(() => {
      initEnv();
    });

    it.each(Object.entries(ZERO_ARG_OUTCOMES) as [ToolName, ZeroArgOutcome][])(
      "%s: handle() should not crash before reaching the ClientManager",
      async (name, outcome) => {
        const { clientManager, clientGetters } = stubClientGetters();

        const runtime = allServicesRuntime(clientManager);

        const handler = ToolHandlerRegistry.getToolHandler(name);

        // Precondition: { resolves } must carry a real substring, not ""
        if ("resolves" in outcome) {
          expect(
            outcome.resolves,
            `${name}: resolves must be a non-empty substring, not ""`,
          ).not.toBe("");
        }

        let result: Awaited<ReturnType<typeof handler.handle>> | undefined;
        let thrown: unknown;
        try {
          result = await handler.handle(runtime, {}, undefined);
        } catch (err) {
          thrown = err;
        }

        if (thrown === undefined) {
          // Outcome table must declare { resolves }, not { throws }
          expect(
            "resolves" in outcome,
            `${name}: resolved successfully but outcome specifies { throws }`,
          ).toBe(true);

          // Response text must contain the declared substring
          const { resolves } = outcome as Resolves;
          const responseText = result!.content
            .map((c) => ("text" in c ? c.text : ""))
            .join("");
          expect(
            responseText,
            `${name}: response text does not contain expected substring`,
          ).toContain(resolves);

          // At least one client getter must have been called
          expect(
            clientGetters.some((m) => m.mock.calls.length > 0),
            `${name}: resolved without error but no client getter was called`,
          ).toBe(true);
        } else {
          // We expect specific error/message to have been thrown.
          // Outcome table must declare { throws }, not { resolves }
          expect(
            "throws" in outcome,
            `${name}: handler threw but outcome specifies { resolves }`,
          ).toBe(true);

          // Classify the thrown value into a comparable string
          let actual: string;
          if (thrown instanceof ZodError) {
            // We don't care about which exact ZodError it is, because
            // that's determined by the ordering of zod refinements in the handler, which is an
            // internal detail.
            actual = "ZodError";
          } else if (thrown instanceof Error) {
            actual = thrown.message;
          } else {
            throw new Error(
              `Wacky -- ${name}: handler threw a non-Error value: ${JSON.stringify(thrown)}`,
            );
          }

          expect(
            actual,
            `${name}: unexpected error — update ZERO_ARG_OUTCOMES table with actual`,
          ).toContain((outcome as Throws).throws);
        }
      },
    );
  });
});
