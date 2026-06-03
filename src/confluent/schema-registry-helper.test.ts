import { SchemaRegistryClient, SerdeType } from "@confluentinc/schemaregistry";
import {
  buildProtobufMessage,
  checkSchemaNeeded,
  deserializeMessage,
  getDeserializer,
  getLatestSchemaIfExists,
  getLatestSchemaOfTypeOrThrow,
  getSerializer,
  protobufRegistryFromSerialized,
  serializeMessage,
} from "@src/confluent/schema-registry-helper.js";
import { getMockedSchemaRegistry } from "@tests/stubs/index.js";
import { beforeEach, describe, expect, it } from "vitest";

const PROTO_USER = `syntax = "proto3";
package com.example;

message User {
  string user_id = 1;
  string name = 2;
  string email = 3;
  int32 age = 4;
}`;

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

  describe("buildProtobufMessage()", () => {
    it("builds a typed message (with $typeName) from snake_case payload keys", () => {
      const { message } = buildProtobufMessage(PROTO_USER, "com.example.User", {
        user_id: "USR-001",
        name: "Alice",
        age: 30,
      });
      const fields = message as Record<string, unknown>;
      expect(fields.$typeName).toBe("com.example.User");
      expect(fields.userId).toBe("USR-001");
      expect(fields.name).toBe("Alice");
      expect(fields.age).toBe(30);
    });

    it("requires payload keys to match the proto field names (snake_case)", () => {
      // protobufjs preserves the declared field names (keepCase), so the JSON
      // payload must use the proto field name `user_id`, not camelCase `userId`.
      expect(() =>
        buildProtobufMessage(PROTO_USER, "com.example.User", {
          userId: "USR-002",
        }),
      ).toThrow(/unknown/);
    });

    it("throws listing available message types when messageName is unknown", () => {
      expect(() =>
        buildProtobufMessage(PROTO_USER, "com.example.Missing", {}),
      ).toThrow(/Available message types: com\.example\.User/);
    });

    it("throws a parse error for malformed .proto text", () => {
      expect(() =>
        buildProtobufMessage("this is not protobuf", "com.example.User", {}),
      ).toThrow(/Failed to parse Protobuf schema/);
    });
  });

  describe("serializeMessage() with PROTOBUF", () => {
    // A real mock:// Schema Registry client serializes/deserializes entirely
    // in-memory (no network), so the round-trip proves the produced bytes are
    // valid Protobuf tagged with the right schema id.
    const newRegistry = (): SchemaRegistryClient =>
      SchemaRegistryClient.newClient({
        baseURLs: ["mock://"],
      }) as SchemaRegistryClient;

    it("registers the schema and serializes a payload that round-trips", async () => {
      const registry = newRegistry();
      const topic = "proto-roundtrip";
      const bytes = await serializeMessage(
        topic,
        {
          message: {
            user_id: "USR-001",
            name: "Alice",
            email: "alice@example.com",
            age: 30,
          },
          useSchemaRegistry: true,
          schemaType: "PROTOBUF",
          schema: PROTO_USER,
          messageName: "com.example.User",
        },
        SerdeType.VALUE,
        registry,
      );
      expect(Buffer.isBuffer(bytes)).toBe(true);

      const decoded = await deserializeMessage(
        topic,
        bytes as Buffer,
        "PROTOBUF",
        registry,
        SerdeType.VALUE,
      );
      expect(decoded).toEqual({
        $typeName: "com.example.User",
        userId: "USR-001",
        name: "Alice",
        email: "alice@example.com",
        age: 30,
      });
    });

    it("uses the latest registered schema when no schema is supplied", async () => {
      const registry = newRegistry();
      const topic = "proto-latest";
      // First produce WITH the schema so the serializer registers it in the
      // serialized (base64 FileDescriptorProto) format the SDK expects, mimicking
      // a prior produce. A subsequent produce then exercises the use-latest path.
      await serializeMessage(
        topic,
        {
          message: { user_id: "USR-000", name: "Seed" },
          useSchemaRegistry: true,
          schemaType: "PROTOBUF",
          schema: PROTO_USER,
          messageName: "com.example.User",
        },
        SerdeType.VALUE,
        registry,
      );

      const bytes = await serializeMessage(
        topic,
        {
          message: { user_id: "USR-009", name: "Bob" },
          useSchemaRegistry: true,
          schemaType: "PROTOBUF",
          messageName: "com.example.User",
        },
        SerdeType.VALUE,
        registry,
      );

      const decoded = await deserializeMessage(
        topic,
        bytes as Buffer,
        "PROTOBUF",
        registry,
        SerdeType.VALUE,
      );
      expect(decoded).toEqual({
        $typeName: "com.example.User",
        userId: "USR-009",
        name: "Bob",
        email: "",
        age: 0,
      });
    });

    it("throws an actionable error when the registered schema is not PROTOBUF (use-latest path)", async () => {
      const registry = newRegistry();
      const topic = "proto-mismatch";
      // Seed the subject with an AVRO schema, then attempt a PROTOBUF produce
      // without supplying a schema (use-latest). The mismatch must surface as a
      // clear error rather than a confusing base64 decode failure.
      await serializeMessage(
        topic,
        {
          message: { x: 1 },
          useSchemaRegistry: true,
          schemaType: "AVRO",
          schema:
            '{"type":"record","name":"X","fields":[{"name":"x","type":"int"}]}',
        },
        SerdeType.VALUE,
        registry,
      );

      await expect(
        serializeMessage(
          topic,
          {
            message: { user_id: "USR-001" },
            useSchemaRegistry: true,
            schemaType: "PROTOBUF",
            messageName: "com.example.User",
          },
          SerdeType.VALUE,
          registry,
        ),
      ).rejects.toThrow(
        /is registered as AVRO, but the requested schemaType is PROTOBUF/,
      );
    });

    it("throws when messageName is missing for PROTOBUF", async () => {
      const registry = newRegistry();
      await expect(
        serializeMessage(
          "proto-missing",
          {
            message: { user_id: "USR-001" },
            useSchemaRegistry: true,
            schemaType: "PROTOBUF",
            schema: PROTO_USER,
          },
          SerdeType.VALUE,
          registry,
        ),
      ).rejects.toThrow(/messageName is required/);
    });
  });

  describe("serializeMessage() use-latest schema-type validation", () => {
    const newRegistry = (): SchemaRegistryClient =>
      SchemaRegistryClient.newClient({
        baseURLs: ["mock://"],
      }) as SchemaRegistryClient;

    it("throws when the requested schemaType differs from the registered one (AVRO subject, JSON request)", async () => {
      const registry = newRegistry();
      const topic = "type-mismatch";
      // Register an AVRO schema, then attempt a use-latest produce asking for
      // JSON. Without the upfront check this fails as an opaque serializer error.
      await serializeMessage(
        topic,
        {
          message: { x: 1 },
          useSchemaRegistry: true,
          schemaType: "AVRO",
          schema:
            '{"type":"record","name":"X","fields":[{"name":"x","type":"int"}]}',
        },
        SerdeType.VALUE,
        registry,
      );

      await expect(
        serializeMessage(
          topic,
          { message: { x: 1 }, useSchemaRegistry: true, schemaType: "JSON" },
          SerdeType.VALUE,
          registry,
        ),
      ).rejects.toThrow(
        /is registered as AVRO, but the requested schemaType is JSON/,
      );
    });
  });

  describe("getSerializer()", () => {
    it.each(["AVRO", "JSON"] as const)(
      "should return a serializer for %s",
      (schemaType) => {
        const registry = getMockedSchemaRegistry();
        expect(
          getSerializer(schemaType, registry, SerdeType.VALUE),
        ).toBeDefined();
      },
    );

    it("should throw for PROTOBUF (handled by serializeProtobufMessage)", () => {
      const registry = getMockedSchemaRegistry();
      expect(() =>
        getSerializer("PROTOBUF", registry, SerdeType.VALUE),
      ).toThrow(/goes through serializeProtobufMessage/);
    });

    it("should throw for an unknown schema type", () => {
      const registry = getMockedSchemaRegistry();
      expect(() =>
        getSerializer("XML" as unknown as "AVRO", registry, SerdeType.VALUE),
      ).toThrow(/Unknown schemaType: XML/);
    });

    it("should throw when the schema type is undefined", () => {
      const registry = getMockedSchemaRegistry();
      expect(() => getSerializer(undefined, registry, SerdeType.VALUE)).toThrow(
        /Unknown schemaType/,
      );
    });
  });

  describe("getDeserializer()", () => {
    it.each(["AVRO", "JSON", "PROTOBUF"] as const)(
      "should return a deserializer for %s",
      (schemaType) => {
        const registry = getMockedSchemaRegistry();
        expect(
          getDeserializer(schemaType, registry, SerdeType.VALUE),
        ).toBeDefined();
      },
    );

    it("should throw for an unknown schema type", () => {
      const registry = getMockedSchemaRegistry();
      expect(() =>
        getDeserializer("XML" as unknown as "AVRO", registry, SerdeType.VALUE),
      ).toThrow(/Unknown schemaType: XML/);
    });
  });

  describe("getLatestSchemaIfExists()", () => {
    it("should return null when the subject is not found (404)", async () => {
      const registry = getMockedSchemaRegistry();
      registry.getLatestSchemaMetadata.mockRejectedValue({ status: 404 });
      expect(await getLatestSchemaIfExists(registry, "missing")).toBeNull();
    });

    it("should rethrow non-404 errors", async () => {
      const registry = getMockedSchemaRegistry();
      registry.getLatestSchemaMetadata.mockRejectedValue({ status: 500 });
      await expect(getLatestSchemaIfExists(registry, "boom")).rejects.toEqual({
        status: 500,
      });
    });

    it("should default the schema type to AVRO when none is reported", async () => {
      const registry = getMockedSchemaRegistry();
      registry.getLatestSchemaMetadata.mockResolvedValue({
        id: 1,
        version: 1,
        subject: "orders-value",
        schema: '{"type":"record","name":"X","fields":[]}',
      });
      expect(await getLatestSchemaIfExists(registry, "orders-value")).toEqual({
        schema: '{"type":"record","name":"X","fields":[]}',
        schemaType: "AVRO",
      });
    });
  });

  describe("getLatestSchemaOfTypeOrThrow()", () => {
    it("should throw when no schema is registered for the subject", async () => {
      const registry = getMockedSchemaRegistry();
      registry.getLatestSchemaMetadata.mockRejectedValue({ status: 404 });
      await expect(
        getLatestSchemaOfTypeOrThrow(registry, "orders-value", "AVRO"),
      ).rejects.toThrow(/No AVRO schema registered for subject 'orders-value'/);
    });
  });

  describe("protobufRegistryFromSerialized()", () => {
    it("should throw an actionable error when the stored schema cannot be decoded", () => {
      expect(() =>
        protobufRegistryFromSerialized("not-valid-base64$$"),
      ).toThrow(/Failed to decode registered Protobuf schema/);
    });
  });

  describe("serializeMessage() guards", () => {
    it("should stringify a non-string payload when schema registry is disabled", async () => {
      const registry = getMockedSchemaRegistry();
      const result = await serializeMessage(
        "orders",
        { message: { x: 1 }, useSchemaRegistry: false },
        SerdeType.VALUE,
        registry,
      );
      expect(result).toBe('{"x":1}');
    });

    it("should throw when schemaType is missing and useSchemaRegistry is true", async () => {
      const registry = getMockedSchemaRegistry();
      await expect(
        serializeMessage(
          "orders",
          { message: { x: 1 }, useSchemaRegistry: true },
          SerdeType.VALUE,
          registry,
        ),
      ).rejects.toThrow(
        /schemaType is required when useSchemaRegistry is true/,
      );
    });

    it("should throw when the registry client is missing", async () => {
      await expect(
        serializeMessage(
          "orders",
          { message: { x: 1 }, useSchemaRegistry: true, schemaType: "AVRO" },
          SerdeType.VALUE,
          undefined,
        ),
      ).rejects.toThrow(/Schema Registry client is required/);
    });

    it("should throw when the message is not an object", async () => {
      const registry = getMockedSchemaRegistry();
      await expect(
        serializeMessage(
          "orders",
          { message: "raw", useSchemaRegistry: true, schemaType: "AVRO" },
          SerdeType.VALUE,
          registry,
        ),
      ).rejects.toThrow(/message must be an object matching the schema/);
    });

    it("should wrap a registration failure with an actionable message", async () => {
      const registry = getMockedSchemaRegistry();
      registry.register.mockRejectedValue(new Error("conflict"));
      await expect(
        serializeMessage(
          "orders",
          {
            message: { x: 1 },
            useSchemaRegistry: true,
            schemaType: "AVRO",
            schema: '{"type":"record","name":"X","fields":[]}',
          },
          SerdeType.VALUE,
          registry,
        ),
      ).rejects.toThrow(/Failed to register schema for subject 'orders-value'/);
    });
  });

  describe("deserializeMessage() failure", () => {
    it("should wrap deserialization errors", async () => {
      const registry = getMockedSchemaRegistry();
      await expect(
        deserializeMessage(
          "orders",
          Buffer.from([0, 1, 2, 3]),
          "AVRO",
          registry,
          SerdeType.VALUE,
        ),
      ).rejects.toThrow(/Failed to deserialize message/);
    });
  });
});
