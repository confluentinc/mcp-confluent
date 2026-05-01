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

    /** Classifies a thrown value into the string used for matching in ZERO_ARG_OUTCOMES. */
    function classifyThrown(name: string, thrown: unknown): string {
      if (thrown instanceof ZodError) return "ZodError";
      if (thrown instanceof Error) return thrown.message;
      throw new Error(
        `Wacky -- ${name}: handler threw a non-Error value: ${JSON.stringify(thrown)}`,
      );
    }

    /**
     * Wires every client getter on a fresh `Mocked<DefaultClientManager>` to a
     * two-proxy pair so handler bodies never throw a TypeError before reaching
     * real logic. Supply `responseData` to push a specific handler past schema
     * validation into its success branch (defaults to `{}`).
     *
     * Returns `{ clientManager, clientGetters }`. `clientGetters` is the canonical
     * list of all getter mocks; callers use it to assert that at least one was
     * invoked when a handler resolves successfully.
     *
     * (No explicit return type: `clientGetters` is a heterogeneous array of mock
     * method references whose element type is too verbose to write by hand — inference
     * is clearer here than annotation would be.)
     */
    function stubClientGetters(responseData: unknown = {}) {
      // Two-proxy setup: callableProxy (function target) handles method chains
      // and calls; responseProxy (plain-object target) is what async calls
      // resolve to.
      let responseProxy: object = {};
      const callableProxy = new Proxy((() => {}) as () => Promise<object>, {
        get: (_t, prop) => {
          if (prop === "then" || prop === "error") return undefined;
          return callableProxy;
        },
        apply: () => Promise.resolve(responseProxy),
      });
      responseProxy = new Proxy({} as object, {
        // Four properties are special-cased:
        //   `then`            → undefined  (prevents JS treating this as a thenable)
        //   `error`           → undefined  (openapi-fetch "success" signal)
        //   `data`            → responseData  (caller-supplied; defaults to {})
        //   Symbol.iterator   → empty-array iterator (handlers that iterate the
        //                       resolved value directly get an empty loop, not a
        //                       TypeError)
        get: (_t, prop) => {
          if (prop === "then" || prop === "error") return undefined;
          if (prop === "data") return responseData;
          if (prop === Symbol.iterator)
            return Array.prototype[Symbol.iterator].bind([]);
          return callableProxy;
        },
      });
      const clientManager = createMockInstance(DefaultClientManager);
      clientManager.getAdminClient.mockResolvedValue(callableProxy as never);
      clientManager.getProducer.mockResolvedValue(callableProxy as never);
      clientManager.getConsumer.mockResolvedValue(callableProxy as never);
      clientManager.getConfluentCloudFlinkRestClient.mockReturnValue(
        callableProxy as never,
      );
      clientManager.getConfluentCloudRestClient.mockReturnValue(
        callableProxy as never,
      );
      clientManager.getConfluentCloudTableflowRestClient.mockReturnValue(
        callableProxy as never,
      );
      clientManager.getConfluentCloudSchemaRegistryRestClient.mockReturnValue(
        callableProxy as never,
      );
      clientManager.getConfluentCloudKafkaRestClient.mockReturnValue(
        callableProxy as never,
      );
      clientManager.getConfluentCloudTelemetryRestClient.mockReturnValue(
        callableProxy as never,
      );
      clientManager.getSchemaRegistryClient.mockReturnValue(
        callableProxy as never,
      );
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

    type Resolves = {
      /** Minimal valid API response to feed into the proxy's `data` property.
       *  Omit to use `{}` (sufficient when the handler just JSON-serialises the
       *  response); supply `{ data: [] }` or a richer shape to push the handler
       *  past schema validation into its real success branch. */
      responseData?: unknown;
      /** Substring that must appear in the resolved response text. */
      resolves: string;
    };
    type Throws = {
      /** Same as `Resolves.responseData` — set when the handler needs valid-ish
       *  data before it reaches the code that throws. */
      responseData?: unknown;
      /** Substring that must appear in the thrown error message, or "ZodError"
       *  to match any ZodError regardless of message. */
      throws: string;
    };
    /** Complete smoke-test specification for one handler: what to feed in
     *  (`responseData`) and what to expect out (`resolves` / `throws`).
     *  The string sentinel value triggers a "golden file"-style discovery run:
     *  the test executes the handler, reports the actual outcome, and asks you
     *  to paste it in as the recorded expectation. */
    type HandleSmokeCase = Resolves | Throws | "TODO";

    // Reverse map from enum value ("list-topics") → enum key ("LIST_TOPICS"),
    // used to generate helpful copy-paste suggestions in failure messages.
    const TOOL_NAME_TO_KEY = Object.fromEntries(
      Object.entries(ToolName).map(([k, v]) => [v, k]),
    ) as Record<ToolName, string>;

    /**
     * What each handler produces when called with no arguments against a
     * fully-wired universal client. Use `{ resolves }` when the handler
     * completes and `{ throws }` when it raises before returning.
     * Use `"TODO"` as a placeholder — the smoke test will run the handler
     * and report the correct entry to paste in.
     */
    const ZERO_ARG_OUTCOMES: Partial<Record<ToolName, HandleSmokeCase>> = {
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
          `Add [ToolName.${TOOL_NAME_TO_KEY[name]}]: "TODO" to ZERO_ARG_OUTCOMES, ` +
            `then run: npm test -- src/confluent/tools/tool-registry.test.ts`,
        ).toBe(true);
      },
    );

    it.each(Object.entries(ZERO_ARG_OUTCOMES) as [ToolName, HandleSmokeCase][])(
      "%s: handle() should not crash before reaching the ClientManager",
      async (name, outcome) => {
        const responseData =
          typeof outcome === "object" && "responseData" in outcome
            ? outcome.responseData
            : undefined;
        const { clientManager, clientGetters } =
          stubClientGetters(responseData);

        const runtime = allServicesRuntime(clientManager);

        const handler = ToolHandlerRegistry.getToolHandler(name);

        // Precondition: { resolves } must carry a real substring, not ""
        if (typeof outcome === "object" && "resolves" in outcome) {
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

        // Placeholder sentinel: run completed — report what to replace it with
        if (outcome === "TODO") {
          const discovered =
            thrown === undefined
              ? `{ resolves: "${result!.content
                  .map((c) => ("text" in c ? c.text : ""))
                  .join("")
                  .slice(0, 60)}" }`
              : `{ throws: "${classifyThrown(name, thrown)}" }`;
          throw new Error(
            `${name}: outcome is TODO — replace with: ${discovered}`,
          );
        }

        if (thrown === undefined) {
          // Outcome table must declare { resolves }, not { throws }
          expect(
            typeof outcome === "object" && "resolves" in outcome,
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
          // Outcome table must declare { throws }, not { resolves }
          expect(
            typeof outcome === "object" && "throws" in outcome,
            `${name}: handler threw but outcome specifies { resolves }`,
          ).toBe(true);

          expect(
            classifyThrown(name, thrown),
            `${name}: unexpected error — update ZERO_ARG_OUTCOMES table with actual`,
          ).toContain((outcome as Throws).throws);
        }
      },
    );
  });
});
