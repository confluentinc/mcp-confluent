import { DeleteSchemaHandler } from "@src/confluent/tools/handlers/schema/delete-schema-handler.js";
import {
  bareRuntime,
  DEFAULT_CONNECTION_ID,
  schemaRegistryRuntime,
} from "@tests/factories/runtime.js";
import { describe, expect, it } from "vitest";

describe("delete-schema-handler.ts", () => {
  describe("DeleteSchemaHandler", () => {
    const handler = new DeleteSchemaHandler();

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
