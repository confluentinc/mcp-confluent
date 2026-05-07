import { ToolDisabledReason } from "@src/confluent/tools/connection-predicates.js";
import {
  bareRuntime,
  CCLOUD_CONN,
  ccloudOAuthRuntime,
  DEFAULT_CONNECTION_ID,
  kafkaRuntime,
  runtimeWith,
} from "@tests/factories/runtime.js";
import { StubHandler } from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

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

    describe("resolveSoleDirectConnection()", () => {
      const resolveSoleDirectConnection = handler[
        "resolveSoleDirectConnection"
      ].bind(handler) as (typeof handler)["resolveSoleDirectConnection"];

      it("should narrow conn to DirectConnectionConfig under direct", () => {
        const runtime = runtimeWith(CCLOUD_CONN);
        const { conn } = resolveSoleDirectConnection(runtime);
        // Type-narrowed access to the direct-only `confluent_cloud` field is
        // the contract this method exists to provide.
        expect(conn.confluent_cloud?.endpoint).toBe(
          "https://api.confluent.cloud",
        );
      });

      it("should throw when the connection is OAuth-typed", () => {
        expect(() => resolveSoleDirectConnection(ccloudOAuthRuntime())).toThrow(
          /requires a direct \(non-OAuth\) connection/,
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
  });
});
