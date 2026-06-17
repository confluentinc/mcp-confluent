import { IHeaders } from "@confluentinc/kafka-javascript/types/kafkajs.js";
import {
  KEY_SCHEMA_ID_HEADER,
  SerdeType,
  VALUE_SCHEMA_ID_HEADER,
} from "@confluentinc/schemaregistry";
import {
  checkSchemaNeeded,
  deserializeMessage,
  serializeMessage,
} from "@src/confluent/schema-registry-helper.js";
import { getMockedSchemaRegistry } from "@tests/stubs/index.js";
import { beforeEach, describe, expect, it } from "vitest";

const MAGIC_BYTE_V1 = 1;
const TEST_GUID = "89e3a8f1-1111-2222-3333-444455556666";

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

    describe("schemaIdLocation (header vs prefix wire format)", () => {
      // The header serializer encodes the schema GUID (MAGIC_BYTE_V1 + 16-byte
      // UUID), not the int id, so the registry stub must surface a guid for the
      // serialize step and resolve it back by guid for the deserialize step.
      function stubRegistryForGuid(schema: string): void {
        registry.getAssociationsByResourceName.mockResolvedValue([]);
        registry.getLatestSchemaMetadata.mockResolvedValue({
          id: 1,
          guid: TEST_GUID,
          version: 1,
          subject: "orders-value",
          schema,
          schemaType: "AVRO",
        });
        registry.getByGuid.mockResolvedValue({ schema, schemaType: "AVRO" });
      }

      it("should write the schema GUID to the value header, leave the payload prefix-free, and round-trip via the header", async () => {
        stubRegistryForGuid('"string"');
        const recordHeaders: IHeaders = {};

        const serialized = await serializeMessage(
          "orders",
          {
            message: "hello",
            useSchemaRegistry: true,
            schemaType: "AVRO",
            schemaIdLocation: "header",
          },
          SerdeType.VALUE,
          registry,
          recordHeaders,
        );

        const idHeader = recordHeaders[VALUE_SCHEMA_ID_HEADER];
        expect(Buffer.isBuffer(idHeader)).toBe(true);
        expect((idHeader as Buffer).length).toBe(17);
        expect((idHeader as Buffer)[0]).toBe(MAGIC_BYTE_V1);
        // Bare Avro string "hello": zigzag length 0x0a then the bytes — no
        // leading magic byte 0 + 4-byte id that the prefix format prepends.
        expect((serialized as Buffer)[0]).not.toBe(0);

        const roundTripped = await deserializeMessage(
          "orders",
          serialized as Buffer,
          "AVRO",
          registry,
          SerdeType.VALUE,
          recordHeaders,
        );
        expect(roundTripped).toBe("hello");
      });

      it("should write the __key_schema_id header for SerdeType.KEY in header mode", async () => {
        stubRegistryForGuid('"string"');
        const recordHeaders: IHeaders = {};

        await serializeMessage(
          "orders",
          {
            message: "k1",
            useSchemaRegistry: true,
            schemaType: "AVRO",
            schemaIdLocation: "header",
          },
          SerdeType.KEY,
          registry,
          recordHeaders,
        );

        expect(Buffer.isBuffer(recordHeaders[KEY_SCHEMA_ID_HEADER])).toBe(true);
        expect(recordHeaders[VALUE_SCHEMA_ID_HEADER]).toBeUndefined();
      });

      it("should leave the headers accumulator untouched and prefix the payload in prefix mode (default)", async () => {
        stubRegistryForGuid('"string"');
        const recordHeaders: IHeaders = {};

        const serialized = await serializeMessage(
          "orders",
          {
            message: "hello",
            useSchemaRegistry: true,
            schemaType: "AVRO",
            schemaIdLocation: "prefix",
          },
          SerdeType.VALUE,
          registry,
          recordHeaders,
        );

        expect(recordHeaders[VALUE_SCHEMA_ID_HEADER]).toBeUndefined();
        expect((serialized as Buffer)[0]).toBe(0);
      });

      it("should throw a subject-scoped error when the registry returns no guid for header mode", async () => {
        registry.getAssociationsByResourceName.mockResolvedValue([]);
        registry.getLatestSchemaMetadata.mockResolvedValue({
          id: 1,
          version: 1,
          subject: "orders-value",
          schema: '"string"',
          schemaType: "AVRO",
        });

        await expect(
          serializeMessage(
            "orders",
            {
              message: "hello",
              useSchemaRegistry: true,
              schemaType: "AVRO",
              schemaIdLocation: "header",
            },
            SerdeType.VALUE,
            registry,
            {},
          ),
        ).rejects.toThrow(/orders-value.*guid/i);
      });
    });
  });
});
