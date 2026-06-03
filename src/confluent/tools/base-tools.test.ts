import { READ_ONLY } from "@src/confluent/tools/base-tools.js";
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
import { describe, expect, it } from "vitest";
import { z } from "zod";

describe("base-tools.ts", () => {
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

        it("should describe connectionId with the viable ids and a pointer to list-connections", () => {
          const connectionId = injectedConnectionId(
            runtimeWithConnections({ a: KAFKA, b: KAFKA }),
          );

          expect(connectionId.description).toContain("a, b");
          expect(connectionId.description).toContain("list-connections");
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
