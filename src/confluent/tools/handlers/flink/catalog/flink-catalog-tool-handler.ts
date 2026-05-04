import { CallToolResult } from "@src/confluent/schema.js";
import { resolveCatalogName } from "@src/confluent/tools/handlers/flink/catalog/catalog-resolver.js";
import { FlinkToolHandler } from "@src/confluent/tools/handlers/flink/flink-tool-handler.js";

export type CatalogResolution =
  | { ok: true; name: string }
  | { ok: false; error: CallToolResult };

/** Intermediate base class for Flink catalog tool handlers */
export abstract class FlinkCatalogToolHandler extends FlinkToolHandler {
  protected resolveCatalogNameOrError(
    catalogName: string | undefined,
    environmentId: string,
  ): CatalogResolution {
    const name = resolveCatalogName(catalogName, environmentId);
    if (!name)
      return {
        ok: false,
        error: this.createResponse(
          "Catalog name could not be resolved. Pass catalogName (env-xxxxx) explicitly, or set flink.environment_id in config.",
          true,
        ),
      };
    return { ok: true, name };
  }
}
