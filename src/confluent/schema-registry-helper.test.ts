import { SchemaRegistryClient, SerdeType } from "@confluentinc/schemaregistry";
import {
  buildProtobufMessage,
  checkSchemaNeeded,
  deserializeMessage,
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
});
