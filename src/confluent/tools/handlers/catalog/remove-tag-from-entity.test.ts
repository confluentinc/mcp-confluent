import { RemoveTagFromEntityHandler } from "@src/confluent/tools/handlers/catalog/remove-tag-from-entity.js";
import {
  bareRuntime,
  DEFAULT_CONNECTION_ID,
  schemaRegistryRuntime,
} from "@tests/factories/runtime.js";
import { describe, expect, it } from "vitest";

describe("remove-tag-from-entity.ts", () => {
  describe("RemoveTagFromEntityHandler", () => {
    const handler = new RemoveTagFromEntityHandler();

    describe("enabledConnectionIds()", () => {
      it("should return the connection ID for a connection with a schema_registry block", () => {
        expect(handler.enabledConnectionIds(schemaRegistryRuntime())).toEqual([
          DEFAULT_CONNECTION_ID,
        ]);
      });

      it("should return an empty array for a connection without a schema_registry block", () => {
        expect(handler.enabledConnectionIds(bareRuntime())).toEqual([]);
      });
    });
  });
});
