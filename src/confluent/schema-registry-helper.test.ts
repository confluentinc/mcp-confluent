import { SerdeType } from "@confluentinc/schemaregistry";
import {
  checkSchemaNeeded,
  deserializeMessage,
  serializeMessage,
} from "@src/confluent/schema-registry-helper.js";
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

  describe("serializeMessage()", () => {
    let registry: ReturnType<typeof getMockedSchemaRegistry>;

    beforeEach(() => {
      registry = getMockedSchemaRegistry();
    });

    describe("without schema registry", () => {
      it("should pass a string payload through unchanged", async () => {
        const result = await serializeMessage(
          "orders",
          { message: "raw", useSchemaRegistry: false },
          SerdeType.VALUE,
          undefined,
        );
        expect(result).toBe("raw");
      });

      it.each([
        { name: "number", message: 123, expected: "123" },
        { name: "boolean", message: true, expected: "true" },
        { name: "object", message: { x: 1 }, expected: '{"x":1}' },
      ])(
        "should JSON-encode a $name payload",
        async ({ message, expected }) => {
          const result = await serializeMessage(
            "orders",
            { message, useSchemaRegistry: false },
            SerdeType.VALUE,
            undefined,
          );
          expect(result).toBe(expected);
        },
      );
    });

    describe("with schema registry and a primitive top-level schema", () => {
      it.each([
        { name: "Avro long", message: 123, schema: '"long"' },
        { name: "Avro boolean", message: true, schema: '"boolean"' },
        { name: "Avro string", message: "hello", schema: '"string"' },
      ])(
        "should serialize a $name primitive and round-trip it back to the value",
        async ({ message, schema }) => {
          // No subject association registered → the serializer falls back to
          // the {topic}-value naming strategy rather than throwing.
          registry.getAssociationsByResourceName.mockResolvedValue([]);
          // The latest-registered schema drives serialization; the same schema,
          // resolved by id, drives the deserialize round-trip.
          registry.getLatestSchemaMetadata.mockResolvedValue({
            id: 1,
            version: 1,
            subject: "orders-value",
            schema,
            schemaType: "AVRO",
          });
          registry.getBySubjectAndId.mockResolvedValue({
            schema,
            schemaType: "AVRO",
          });

          const serialized = await serializeMessage(
            "orders",
            { message, useSchemaRegistry: true, schemaType: "AVRO" },
            SerdeType.VALUE,
            registry,
          );

          expect(Buffer.isBuffer(serialized)).toBe(true);
          const roundTripped = await deserializeMessage(
            "orders",
            serialized as Buffer,
            "AVRO",
            registry,
            SerdeType.VALUE,
          );
          expect(roundTripped).toBe(message);
        },
      );

      it("should reject a null payload with a non-null-required message", async () => {
        await expect(
          serializeMessage(
            "orders",
            {
              message: null as unknown as object,
              useSchemaRegistry: true,
              schemaType: "AVRO",
            },
            SerdeType.VALUE,
            registry,
          ),
        ).rejects.toThrow(
          "When using schema registry, a non-null message payload is required.",
        );
      });
    });
  });
});
