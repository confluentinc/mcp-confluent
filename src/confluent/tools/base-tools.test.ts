import {
  CONNECTION_ID_DESCRIPTION_PREFIX,
  LIST_CONFIGURED_CONNECTIONS_POINTER,
  READ_ONLY,
} from "@src/confluent/tools/base-tools.js";
import {
  hasKafka,
  ToolDisabledReason,
} from "@src/confluent/tools/connection-predicates.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  bareRuntime,
  CCLOUD_CONN,
  ccloudOAuthRuntime,
  DEFAULT_CONNECTION_ID,
  kafkaRuntime,
  runtimeWith,
  runtimeWithConnections,
} from "@tests/factories/runtime.js";
import { StubHandler } from "@tests/stubs/index.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

describe("base-tools.ts", () => {
  describe("LIST_CONFIGURED_CONNECTIONS_POINTER", () => {
    it("should name the discovery tool by its current wire name", () => {
      // Tripwire: the pointer's tool name is derived from the ToolName enum, so a
      // future rename that changes the enum value flips this expected literal red
      // and forces a conscious update instead of letting the prose drift stale.
      expect(LIST_CONFIGURED_CONNECTIONS_POINTER).toBe(
        "Discover connections and learn what tools are supported by each connection by invoking 'list-configured-connections'.",
      );
    });
  });

  describe("BaseToolHandler", () => {
    const handler = new StubHandler();

    describe("predicate-derived enabledConnectionIds()", () => {
      it("should return the connection ID for an enabled stub on any runtime", () => {
        expect(new StubHandler().enabledConnectionIds(kafkaRuntime())).toEqual([
          "default",
        ]);
      });

      it("should return an empty array for a disabled stub", () => {
        expect(
          new StubHandler({ enabled: false }).enabledConnectionIds(
            kafkaRuntime(),
          ),
        ).toEqual([]);
      });
    });

    describe("predicate-derived connectionVerdicts()", () => {
      it("should report enabled verdicts for a stub configured as enabled", () => {
        expect(new StubHandler().connectionVerdicts(kafkaRuntime())).toEqual(
          new Map([["default", { enabled: true }]]),
        );
      });

      it("should report disabled verdicts (with a reason) for a stub configured as disabled", () => {
        expect(
          new StubHandler({ enabled: false }).connectionVerdicts(bareRuntime()),
        ).toEqual(
          new Map([
            [
              "default",
              {
                enabled: false,
                reason: ToolDisabledReason.MissingFlinkBlock,
              },
            ],
          ]),
        );
      });
    });

    describe("getRegisteredToolConfig()", () => {
      const KAFKA = { kafka: { bootstrap_servers: "b:9092" } };

      describe("returns the authored config verbatim (no connectionId injected)", () => {
        it.each([
          [
            "connection-neutral tool, no connections",
            () => ({
              handler: new StubHandler({ inputSchema: { query: z.string() } }),
              runtime: runtimeWithConnections({}),
            }),
          ],
          [
            "connection-neutral tool, single connection",
            () => ({
              handler: new StubHandler({ inputSchema: { query: z.string() } }),
              runtime: runtimeWith(),
            }),
          ],
          [
            "connection-neutral tool, two connections (alwaysEnabled short-circuit)",
            () => ({
              handler: new StubHandler({ inputSchema: { query: z.string() } }),
              runtime: runtimeWithConnections({ a: {}, b: {} }),
            }),
          ],
          [
            "connection-centric tool, two connections but none viable",
            () => ({
              handler: new StubHandler({
                predicate: hasKafka,
                inputSchema: { topicName: z.string() },
              }),
              runtime: runtimeWithConnections({ a: {}, b: {} }),
            }),
          ],
          [
            "connection-centric tool, single viable connection",
            () => ({
              handler: new StubHandler({
                predicate: hasKafka,
                inputSchema: { topicName: z.string() },
              }),
              runtime: runtimeWithConnections({ a: KAFKA }),
            }),
          ],
          [
            "connection-centric tool, multiple connections but only one viable",
            () => ({
              handler: new StubHandler({
                predicate: hasKafka,
                inputSchema: { topicName: z.string() },
              }),
              runtime: runtimeWithConnections({ a: KAFKA, b: {} }),
            }),
          ],
        ])("should not inject connectionId for %s", (_label, build) => {
          const { handler, runtime } = build();
          const reg = handler.getRegisteredToolConfig(runtime);

          expect(reg.inputSchema).not.toHaveProperty("connectionId");
          // authored field(s) and metadata pass through unchanged
          expect(Object.keys(reg.inputSchema)).toEqual(
            Object.keys(handler["getToolConfig"]().inputSchema),
          );
          expect(reg.name).toBe(ToolName.LIST_TOPICS);
          expect(reg.description).toBe("stub");
          expect(reg.annotations).toBe(READ_ONLY);
        });

        it("should short-circuit on the alwaysEnabled identity check without scanning connections", () => {
          // alwaysEnabled is identity-checked, so an always-enabled tool must
          // not pay the per-connection enabledConnectionIds() scan even on a
          // multi-connection runtime.
          const handler = new StubHandler({
            inputSchema: { query: z.string() },
          });
          const scan = vi.spyOn(handler, "enabledConnectionIds");

          const reg = handler.getRegisteredToolConfig(
            runtimeWithConnections({ a: {}, b: {} }),
          );

          expect(scan).not.toHaveBeenCalled();
          expect(reg.inputSchema).not.toHaveProperty("connectionId");
        });
      });

      describe("injects a required connectionId enum for a connection-gated tool with multiple viable connections", () => {
        function multiViableHandler(): StubHandler {
          return new StubHandler({
            predicate: hasKafka,
            inputSchema: { topicName: z.string() },
          });
        }

        /** Registers the multi-viable handler against `runtime` and returns the
         * injected connectionId field, narrowed to ZodEnum (throwing if absent
         * or not an enum) so callers can read ZodType members like
         * `isOptional()` / `description`. */
        function injectedConnectionId(
          runtime: Parameters<StubHandler["getRegisteredToolConfig"]>[0],
        ): z.ZodEnum {
          const connectionId =
            multiViableHandler().getRegisteredToolConfig(runtime).inputSchema
              .connectionId;
          if (!(connectionId instanceof z.ZodEnum)) {
            throw new Error("connectionId should be a ZodEnum");
          }
          return connectionId;
        }

        it("should inject an enum of exactly the viable connection ids (excluding non-viable ones), in connection insertion order", () => {
          // Keys deliberately reverse-alphabetical with a non-viable one wedged
          // between, so the assertion distinguishes connection insertion order
          // (the contract) from an accidental sort, and proves the non-viable
          // connection is dropped.
          const reg = multiViableHandler().getRegisteredToolConfig(
            runtimeWithConnections({
              "conn-z": KAFKA,
              "conn-m": {},
              "conn-a": KAFKA,
            }),
          );

          const connectionId = reg.inputSchema.connectionId;
          expect(connectionId).toBeInstanceOf(z.ZodEnum);
          if (!(connectionId instanceof z.ZodEnum)) {
            throw new Error("connectionId should be a ZodEnum");
          }
          expect(connectionId.options).toEqual(["conn-z", "conn-a"]);
        });

        it("should mark connectionId as required (not optional)", () => {
          const connectionId = injectedConnectionId(
            runtimeWithConnections({ a: KAFKA, b: KAFKA }),
          );

          expect(connectionId.isOptional()).toBe(false);
        });

        it("should describe connectionId with the viable ids", () => {
          const connectionId = injectedConnectionId(
            runtimeWithConnections({ a: KAFKA, b: KAFKA }),
          );

          expect(connectionId.description).toContain("a, b");
        });

        const CONNECTION_ID_BASE = `${CONNECTION_ID_DESCRIPTION_PREFIX}a, b.`;

        it("should append the list-configured-connections pointer single-spaced when list-configured-connections is allowed", () => {
          // No allow-list configured ⇒ every tool, including list-configured-connections, is allowed.
          const connectionId = injectedConnectionId(
            runtimeWithConnections({ a: KAFKA, b: KAFKA }),
          );

          expect(connectionId.description).toBe(
            `${CONNECTION_ID_BASE} ${LIST_CONFIGURED_CONNECTIONS_POINTER}`,
          );
        });

        it("should omit the pointer with no dangling trailing space when list-configured-connections is blocked", () => {
          // Allow-list excludes list-configured-connections; the gated tool itself stays allowed.
          const connectionId = injectedConnectionId(
            runtimeWithConnections(
              { a: KAFKA, b: KAFKA },
              undefined,
              new Set([ToolName.LIST_TOPICS]),
            ),
          );

          expect(connectionId.description).toBe(CONNECTION_ID_BASE);
        });

        it("should preserve the handler's pre-existing input fields alongside connectionId", () => {
          const reg = multiViableHandler().getRegisteredToolConfig(
            runtimeWithConnections({ a: KAFKA, b: KAFKA }),
          );

          expect(Object.keys(reg.inputSchema)).toEqual([
            "topicName",
            "connectionId",
          ]);
        });

        it("should not mutate the handler's authored input schema", () => {
          // The handler hands back the same inputSchema object on every
          // getToolConfig() call, so augmenting via mutation (rather than the
          // spread) would leak connectionId back into the authored shape.
          const authoredInputSchema = { topicName: z.string() };
          const handler = new StubHandler({
            predicate: hasKafka,
            inputSchema: authoredInputSchema,
          });

          handler.getRegisteredToolConfig(
            runtimeWithConnections({ a: KAFKA, b: KAFKA }),
          );

          expect(Object.keys(authoredInputSchema)).toEqual(["topicName"]);
        });

        it("should leave name, description, and annotations unchanged", () => {
          const reg = multiViableHandler().getRegisteredToolConfig(
            runtimeWithConnections({ a: KAFKA, b: KAFKA }),
          );

          expect(reg.name).toBe(ToolName.LIST_TOPICS);
          expect(reg.description).toBe("stub");
          expect(reg.annotations).toBe(READ_ONLY);
        });
      });
    });

    describe("resolveSoleConnection()", () => {
      const resolveSoleConnection = handler["resolveSoleConnection"].bind(
        handler,
      ) as (typeof handler)["resolveSoleConnection"];

      it("should return the sole direct connection's id, config, and client manager", () => {
        const runtime = runtimeWith(CCLOUD_CONN);
        const { connId, conn, clientManager } = resolveSoleConnection(runtime);
        expect(connId).toBe(DEFAULT_CONNECTION_ID);
        expect(conn.type).toBe("direct");
        expect(clientManager).toBeDefined();
      });

      it("should return the sole OAuth connection without narrowing", () => {
        const { conn } = resolveSoleConnection(ccloudOAuthRuntime());
        expect(conn.type).toBe("oauth");
      });
    });

    describe("resolveConnection()", () => {
      const KAFKA = { kafka: { bootstrap_servers: "b:9092" } };

      /** Binds the protected resolveConnection off a (possibly predicate-gated)
       * handler so each case can target a handler with the right viability. */
      function resolveConnectionOf(handler: StubHandler) {
        return handler["resolveConnection"].bind(
          handler,
        ) as (typeof handler)["resolveConnection"];
      }

      const kafkaHandler = () => new StubHandler({ predicate: hasKafka });

      it("should route to the explicitly requested connection (not merely the first viable one)", () => {
        const runtime = runtimeWithConnections({
          "conn-a": KAFKA,
          "conn-b": KAFKA,
        });

        const { connId, conn, clientManager } = resolveConnectionOf(
          kafkaHandler(),
        )(runtime, { connectionId: "conn-b" });

        expect(connId).toBe("conn-b");
        expect(conn).toBe(runtime.config.connections["conn-b"]);
        expect(clientManager).toBe(runtime.clientManagers["conn-b"]);
      });

      it.each([
        [
          "an id absent from the configuration entirely",
          () => kafkaHandler(),
          () => runtimeWithConnections({ a: KAFKA, b: KAFKA }),
          "ghost",
          'Wacky -- connection "ghost" is not an enabled connection for this tool; enabled: a, b',
        ],
        [
          "a configured id that this tool's predicate does not enable",
          () => kafkaHandler(),
          () => runtimeWithConnections({ a: KAFKA, b: {} }),
          "b",
          'Wacky -- connection "b" is not an enabled connection for this tool; enabled: a',
        ],
      ])(
        "should throw a listing error for %s",
        (_label, handler, buildRuntime, requested, message) => {
          expect(() =>
            resolveConnectionOf(handler())(buildRuntime(), {
              connectionId: requested,
            }),
          ).toThrow(message);
        },
      );

      it("should auto-route to the sole viable connection when connectionId is omitted", () => {
        const runtime = runtimeWithConnections({ a: KAFKA, b: {} });

        const { connId, conn, clientManager } = resolveConnectionOf(
          kafkaHandler(),
        )(runtime, {});

        expect(connId).toBe("a");
        expect(conn).toBe(runtime.config.connections["a"]);
        expect(clientManager).toBe(runtime.clientManagers["a"]);
      });

      it("should auto-route when toolArguments is undefined entirely", () => {
        const runtime = runtimeWithConnections({ only: KAFKA });

        const { connId } = resolveConnectionOf(kafkaHandler())(
          runtime,
          undefined,
        );

        expect(connId).toBe("only");
      });

      it.each([
        [
          "two or more are viable (ambiguous; schema should have required connectionId)",
          () => runtimeWithConnections({ a: KAFKA, b: KAFKA }),
          "Wacky -- connectionId omitted but this tool is enabled for 2 connections (a, b); cannot auto-route",
        ],
        [
          "none are viable (registration backstop; tool should not have registered)",
          () => runtimeWithConnections({ a: {}, b: {} }),
          "Wacky -- connectionId omitted but this tool is enabled for 0 connections (none); cannot auto-route",
        ],
      ])(
        "should throw when connectionId is omitted and %s",
        (_label, buildRuntime, message) => {
          expect(() =>
            resolveConnectionOf(kafkaHandler())(buildRuntime(), {}),
          ).toThrow(message);
        },
      );

      it.each([
        ["a number", 123, "number"],
        ["null", null, "object"],
        ["an object", { id: "a" }, "object"],
      ])(
        "should throw rather than auto-route when connectionId is present but %s, even with a sole viable connection",
        (_label, requested, typeofName) => {
          // Sole viable connection: absent the guard, a non-string would fall
          // through to the omitted-path and silently auto-route to "a".
          const runtime = runtimeWithConnections({ a: KAFKA, b: {} });

          expect(() =>
            resolveConnectionOf(kafkaHandler())(runtime, {
              connectionId: requested,
            }),
          ).toThrow(
            `Wacky -- connectionId present but not a string (got ${typeofName}); the injected schema should have rejected this`,
          );
        },
      );

      it("should resolve a sole OAuth connection without narrowing its type", () => {
        const { conn } = resolveConnectionOf(new StubHandler())(
          ccloudOAuthRuntime(),
          undefined,
        );

        expect(conn.type).toBe("oauth");
      });
    });

    describe("resolveDirectConnection()", () => {
      const KAFKA = { kafka: { bootstrap_servers: "b:9092" } };

      function resolveDirectConnectionOf(handler: StubHandler) {
        return handler["resolveDirectConnection"].bind(
          handler,
        ) as (typeof handler)["resolveDirectConnection"];
      }

      const kafkaHandler = () => new StubHandler({ predicate: hasKafka });

      it("should narrow the explicitly requested direct connection's id, config, and client manager", () => {
        const runtime = runtimeWithConnections({
          "conn-a": KAFKA,
          "conn-b": KAFKA,
        });

        const { connId, conn, clientManager } = resolveDirectConnectionOf(
          kafkaHandler(),
        )(runtime, { connectionId: "conn-b" });

        expect(connId).toBe("conn-b");
        expect(conn.type).toBe("direct");
        expect(conn).toBe(runtime.config.connections["conn-b"]);
        expect(clientManager).toBe(runtime.clientManagers["conn-b"]);
      });

      it("should auto-route to the sole direct connection when connectionId is omitted", () => {
        const runtime = runtimeWithConnections({ a: KAFKA, b: {} });

        const { connId, conn } = resolveDirectConnectionOf(kafkaHandler())(
          runtime,
          {},
        );

        expect(connId).toBe("a");
        expect(conn.type).toBe("direct");
      });

      it("should throw when the resolved connection is OAuth-typed (direct-only backstop)", () => {
        expect(() =>
          resolveDirectConnectionOf(new StubHandler())(
            ccloudOAuthRuntime(),
            undefined,
          ),
        ).toThrow(
          'Wacky -- connection "default" is oauth-typed; this tool requires a direct connection',
        );
      });

      it("should propagate resolveConnection's listing error for an unknown id (delegation)", () => {
        const runtime = runtimeWithConnections({ a: KAFKA, b: KAFKA });

        expect(() =>
          resolveDirectConnectionOf(kafkaHandler())(runtime, {
            connectionId: "ghost",
          }),
        ).toThrow(
          'Wacky -- connection "ghost" is not an enabled connection for this tool; enabled: a, b',
        );
      });
    });

    describe("resolveParam()", () => {
      // BaseToolHandler.resolveParam() is protected, so we have to work a little bit to get at
      // it for this test suite.
      const resolveParam = handler["resolveParam"].bind(
        handler,
      ) as (typeof handler)["resolveParam"];

      it("should return argValue when both are present", () => {
        expect(resolveParam("arg-val", "cfg-val", "X")).toBe("arg-val");
      });

      it("should fall back to configValue when argValue is absent", () => {
        expect(resolveParam(undefined, "cfg-val", "X")).toBe("cfg-val");
      });

      it("should throw when both are absent", () => {
        expect(() => resolveParam(undefined, undefined, "Org ID")).toThrow(
          "Org ID is required",
        );
      });

      it("should fall back to configValue when argValue is whitespace-only", () => {
        expect(resolveParam("  ", "cfg-val", "X")).toBe("cfg-val");
      });

      it("should throw when argValue is whitespace-only and configValue is absent", () => {
        expect(() => resolveParam("  ", undefined, "Org ID")).toThrow(
          "Org ID is required",
        );
      });

      it("should throw when configValue is whitespace-only and argValue is absent", () => {
        expect(() => resolveParam(undefined, "  ", "Org ID")).toThrow(
          "Org ID is required",
        );
      });
    });

    describe("resolveOptionalParam()", () => {
      const resolveOptionalParam = handler["resolveOptionalParam"].bind(
        handler,
      ) as (typeof handler)["resolveOptionalParam"];

      it("should return argValue when both are present", () => {
        expect(resolveOptionalParam("arg-val", "cfg-val")).toBe("arg-val");
      });

      it("should fall back to configValue when argValue is absent", () => {
        expect(resolveOptionalParam(undefined, "cfg-val")).toBe("cfg-val");
      });

      it("should return undefined when both are absent", () => {
        expect(resolveOptionalParam(undefined, undefined)).toBeUndefined();
      });

      it("should fall back to configValue when argValue is whitespace-only", () => {
        expect(resolveOptionalParam("  ", "cfg-val")).toBe("cfg-val");
      });

      it("should return undefined when argValue is whitespace-only and configValue is absent", () => {
        expect(resolveOptionalParam("  ", undefined)).toBeUndefined();
      });

      it("should return undefined when configValue is whitespace-only and argValue is absent", () => {
        expect(resolveOptionalParam(undefined, "  ")).toBeUndefined();
      });
    });

    describe("createResponse()", () => {
      it("should return a text content block with isError false by default", () => {
        const result = handler.createResponse("hello");
        expect(result.content).toEqual([{ type: "text", text: "hello" }]);
        expect(result.isError).toBe(false);
      });

      it("should set isError true when passed true", () => {
        const result = handler.createResponse("boom", true);
        expect(result.isError).toBe(true);
      });

      it("should attach _meta when provided", () => {
        const meta = { requestId: "abc" };
        const result = handler.createResponse("ok", false, meta);
        expect(result._meta).toBe(meta);
      });

      it("should leave _meta undefined when not provided", () => {
        const result = handler.createResponse("ok");
        expect(result._meta).toBeUndefined();
      });
    });

    describe("createStructuredResponse()", () => {
      it("should carry both a text summary and the structuredContent payload", () => {
        const payload = { groups: [], errors: [] };
        const result = handler.createStructuredResponse("summary", payload);
        expect(result.content).toEqual([{ type: "text", text: "summary" }]);
        expect(result.structuredContent).toBe(payload);
        expect(result.isError).toBe(false);
      });
    });
  });
});
