import { SerdeType } from "@confluentinc/schemaregistry";
import { checkSchemaNeeded } from "@src/confluent/schema-registry-helper.js";
import { getMockedSchemaRegistry } from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

describe("schema-registry-helper.ts", () => {
  describe("checkSchemaNeeded()", () => {
    it("should return null when useSchemaRegistry is false", async () => {
      const registry = getMockedSchemaRegistry();
      const result = await checkSchemaNeeded(
        "orders",
        { message: "raw", useSchemaRegistry: false },
        SerdeType.VALUE,
        registry,
      );
      expect(result).toBeNull();
      expect(registry.getLatestSchemaMetadata).not.toHaveBeenCalled();
    });

    it("should return null when the caller supplied a schema", async () => {
      const registry = getMockedSchemaRegistry();
      const result = await checkSchemaNeeded(
        "orders",
        {
          message: { x: 1 },
          useSchemaRegistry: true,
          schemaType: "AVRO",
          schema: '{"type":"record","name":"X","fields":[]}',
        },
        SerdeType.VALUE,
        registry,
      );
      expect(result).toBeNull();
      expect(registry.getLatestSchemaMetadata).not.toHaveBeenCalled();
    });

    it("should return null when no schema was supplied but one is already registered (use-latest path)", async () => {
      // Regression test for issue #159: subsequent produce calls without
      // re-specifying the schema must proceed (the serializer falls back to
      // useLatestVersion), not error with "A schema already exists".
      const registry = getMockedSchemaRegistry();
      registry.getLatestSchemaMetadata.mockResolvedValue({
        id: 7,
        version: 1,
        subject: "orders-value",
        schema: '{"type":"record","name":"Order","fields":[]}',
        schemaType: "AVRO",
      });
      const result = await checkSchemaNeeded(
        "orders",
        { message: { x: 1 }, useSchemaRegistry: true, schemaType: "AVRO" },
        SerdeType.VALUE,
        registry,
      );
      expect(result).toBeNull();
      expect(registry.getLatestSchemaMetadata).toHaveBeenCalledWith(
        "orders-value",
      );
    });

    it("should return no-schema when nothing is registered and the caller didn't supply one", async () => {
      const registry = getMockedSchemaRegistry();
      registry.getLatestSchemaMetadata.mockRejectedValue({ status: 404 });
      const result = await checkSchemaNeeded(
        "orders",
        { message: { x: 1 }, useSchemaRegistry: true, schemaType: "AVRO" },
        SerdeType.VALUE,
        registry,
      );
      expect(result).toEqual({ type: "no-schema", subject: "orders-value" });
    });

    it("should derive a key-suffixed subject for SerdeType.KEY", async () => {
      const registry = getMockedSchemaRegistry();
      registry.getLatestSchemaMetadata.mockRejectedValue({ status: 404 });
      const result = await checkSchemaNeeded(
        "orders",
        { message: { x: 1 }, useSchemaRegistry: true, schemaType: "AVRO" },
        SerdeType.KEY,
        registry,
      );
      expect(result).toEqual({ type: "no-schema", subject: "orders-key" });
    });

    it("should honor an explicit subject override", async () => {
      const registry = getMockedSchemaRegistry();
      registry.getLatestSchemaMetadata.mockRejectedValue({ status: 404 });
      const result = await checkSchemaNeeded(
        "orders",
        {
          message: { x: 1 },
          useSchemaRegistry: true,
          schemaType: "AVRO",
          subject: "custom-subject",
        },
        SerdeType.VALUE,
        registry,
      );
      expect(result).toEqual({
        type: "no-schema",
        subject: "custom-subject",
      });
    });
  });
});
