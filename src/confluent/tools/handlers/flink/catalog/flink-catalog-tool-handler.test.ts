import { CallToolResult } from "@src/confluent/schema.js";
import { READ_ONLY, ToolConfig } from "@src/confluent/tools/base-tools.js";
import { FlinkCatalogToolHandler } from "@src/confluent/tools/handlers/flink/catalog/flink-catalog-tool-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { describe, expect, it } from "vitest";

class StubCatalogHandler extends FlinkCatalogToolHandler {
  async handle(): Promise<CallToolResult> {
    return this.createResponse("stub");
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.LIST_FLINK_CATALOGS,
      description: "stub",
      inputSchema: {},
      annotations: READ_ONLY,
    };
  }
}

describe("flink-catalog-tool-handler.ts", () => {
  describe("FlinkCatalogToolHandler", () => {
    const handler = new StubCatalogHandler();

    describe("resolveCatalogNameOrError()", () => {
      const resolveCatalogNameOrError =
        handler["resolveCatalogNameOrError"].bind(handler);

      it("should return ok with catalogName when it looks like an env ID", () => {
        expect(
          resolveCatalogNameOrError("env-explicit", "env-from-config"),
        ).toMatchObject({ ok: true, name: "env-explicit" });
      });

      it("should return ok with environmentId when catalogName is absent", () => {
        expect(
          resolveCatalogNameOrError(undefined, "env-from-config"),
        ).toMatchObject({ ok: true, name: "env-from-config" });
      });

      it("should fall back to environmentId when catalogName is a friendly name", () => {
        expect(
          resolveCatalogNameOrError("my-friendly-env", "env-from-config"),
        ).toMatchObject({ ok: true, name: "env-from-config" });
      });

      it("should return an error when environmentId is a friendly name, not an env ID", () => {
        expect(
          resolveCatalogNameOrError(undefined, "production"),
        ).toMatchObject({
          ok: false,
          error: { isError: true },
        });
      });

      it("should return an error when neither catalogName nor environmentId resolves", () => {
        expect(resolveCatalogNameOrError(undefined, "")).toMatchObject({
          ok: false,
          error: {
            isError: true,
            content: [
              {
                type: "text",
                text: expect.stringContaining(
                  "Catalog name could not be resolved",
                ),
              },
            ],
          },
        });
      });
    });
  });
});
