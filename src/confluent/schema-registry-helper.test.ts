import { SerdeType } from "@confluentinc/schemaregistry";
import { checkSchemaNeeded } from "@src/confluent/schema-registry-helper.js";
import { getMockedSchemaRegistry } from "@tests/stubs/index.js";
import { beforeEach, describe, expect, it } from "vitest";

describe("schema-registry-helper.ts", () => {
  describe("checkSchemaNeeded()", () => {
    let registry: ReturnType<typeof getMockedSchemaRegistry>;

    beforeEach(() => {
      registry = getMockedSchemaRegistry();
    });

    it("should return null when useSchemaRegistry is false", async () => {
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

    it.each([
      {
        name: "derives a -value subject for SerdeType.VALUE",
        serdeType: SerdeType.VALUE,
        subject: undefined,
        expected: "orders-value",
      },
      {
        name: "derives a -key subject for SerdeType.KEY",
        serdeType: SerdeType.KEY,
        subject: undefined,
        expected: "orders-key",
      },
      {
        name: "honors an explicit subject override",
        serdeType: SerdeType.VALUE,
        subject: "custom-subject",
        expected: "custom-subject",
      },
    ])(
      "should return no-schema when nothing is registered and it $name",
      async ({ serdeType, subject, expected }) => {
        registry.getLatestSchemaMetadata.mockRejectedValue({ status: 404 });
        const result = await checkSchemaNeeded(
          "orders",
          {
            message: { x: 1 },
            useSchemaRegistry: true,
            schemaType: "AVRO",
            subject,
          },
          serdeType,
          registry,
        );
        expect(result).toEqual({ type: "no-schema", subject: expected });
      },
    );
  });
});
