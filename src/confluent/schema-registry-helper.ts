/**
 * This module provides helper functions for working with Confluent Schema Registry.
 * It handles schema registration, serialization, and deserialization of messages
 * using various schema formats (AVRO, JSON, PROTOBUF).
 */

import {
  createFileRegistry,
  createMutableRegistry,
  fromBinary,
  fromJson,
  MutableRegistry,
} from "@bufbuild/protobuf";
import {
  FileDescriptorProtoSchema,
  FileDescriptorSetSchema,
} from "@bufbuild/protobuf/wkt";
import {
  AvroDeserializer,
  AvroSerializer,
  Deserializer,
  DeserializerConfig,
  JsonDeserializer,
  JsonSerializer,
  ProtobufDeserializer,
  ProtobufSerializer,
  SchemaRegistryClient,
  SerdeType,
  Serializer,
  SerializerConfig,
} from "@confluentinc/schemaregistry";
import { logger } from "@src/logger.js";
import protobuf from "protobufjs";
import descriptor from "protobufjs/ext/descriptor/index.js";

/**
 * Supported schema types for Confluent Schema Registry.
 * AVRO: Apache Avro binary format with schema evolution support
 * JSON: JSON Schema format with validation
 * PROTOBUF: Protocol Buffers format with backward compatibility
 */
export type SchemaType = "AVRO" | "JSON" | "PROTOBUF";

/**
 * Common options for schema registry operations.
 * These options control how schemas are registered and used for serialization.
 */
export interface SchemaRegistryOptions {
  useSchemaRegistry?: boolean;
  schemaType?: SchemaType;
  schema?: string;
  subject?: string;
  normalize?: boolean;
  /**
   * Fully-qualified Protobuf message type to encode the payload as
   * (e.g. `com.example.User`). Required when `schemaType` is `PROTOBUF`,
   * ignored otherwise.
   */
  messageName?: string;
}

/**
 * Options for message serialization/deserialization.
 * Includes the message payload and schema registry configuration.
 */
export type MessageOptions = {
  message: Buffer | object | string;
  useSchemaRegistry?: boolean;
  schemaType?: SchemaType;
  schema?: string;
  subject?: string;
  normalize?: boolean;
  /**
   * Fully-qualified Protobuf message type to encode the payload as
   * (e.g. `com.example.User`). Required when `schemaType` is `PROTOBUF`,
   * ignored otherwise.
   */
  messageName?: string;
};

/**
 * Result of checking if a schema is needed for a message.
 * Returned only when schema registry is in use, the caller did not supply a
 * schema, and no schema is registered for the subject yet — that's the one
 * case the caller must resolve before serialization can proceed. Otherwise
 * null: schema registry is disabled, or the caller supplied a schema
 * (register-and-use path), or one is already registered (use-latest path).
 */
export type SchemaCheckResult = { type: "no-schema"; subject: string } | null;

/**
 * Creates and returns the appropriate serializer instance based on schema type.
 * The serializer is configured to use either a specific schema ID or the latest version.
 *
 * @param schemaType - The type of schema (AVRO, JSON, PROTOBUF)
 * @param registry - The schema registry client instance
 * @param serdeType - Whether this is for key or value serialization
 * @param schemaId - Optional schema ID to use for serialization
 * @returns The appropriate Serializer instance
 * @throws Error if the schema type is unknown or unsupported
 *
 * PROTOBUF never flows through here: {@link serializeMessage} short-circuits to
 * {@link serializeProtobufMessage} (which needs a descriptor registry and
 * auto-register/use-latest semantics rather than the schema-id config used
 * here) before reaching this factory. The PROTOBUF entry below therefore throws
 * explicitly — if that short-circuit is ever removed, this surfaces the
 * assumption loudly instead of silently producing undeserializable bytes.
 */
export function getSerializer(
  schemaType: SchemaType | undefined,
  registry: SchemaRegistryClient,
  serdeType: SerdeType,
  schemaId?: number,
): Serializer {
  const serializerConfig: SerializerConfig =
    typeof schemaId === "number"
      ? { useSchemaId: schemaId }
      : { useLatestVersion: true };

  const serializers = {
    AVRO: () => new AvroSerializer(registry, serdeType, serializerConfig),
    JSON: () => new JsonSerializer(registry, serdeType, serializerConfig),
    PROTOBUF: (): Serializer => {
      throw new Error(
        "PROTOBUF serialization goes through serializeProtobufMessage, not getSerializer",
      );
    },
  };

  if (!schemaType || !(schemaType in serializers)) {
    throw new Error(`Unknown schemaType: ${schemaType}`);
  }

  return serializers[schemaType]();
}

/**
 * Creates and returns the appropriate deserializer instance based on schema type.
 * The deserializer is configured to handle schema evolution and compatibility.
 *
 * @param schemaType - The type of schema (AVRO, JSON, PROTOBUF)
 * @param registry - The schema registry client instance
 * @param serdeType - Whether this is for key or value deserialization
 * @returns The appropriate Deserializer instance
 * @throws Error if the schema type is unknown or unsupported
 */
export function getDeserializer(
  schemaType: SchemaType | undefined,
  registry: SchemaRegistryClient,
  serdeType: SerdeType,
): Deserializer {
  const deserializerConfig: DeserializerConfig = {};

  const deserializers = {
    AVRO: () => new AvroDeserializer(registry, serdeType, deserializerConfig),
    JSON: () => new JsonDeserializer(registry, serdeType, deserializerConfig),
    PROTOBUF: () =>
      new ProtobufDeserializer(registry, serdeType, deserializerConfig),
  };

  if (!schemaType || !(schemaType in deserializers)) {
    throw new Error(`Unknown schemaType: ${schemaType}`);
  }

  return deserializers[schemaType]();
}

/**
 * Checks if a schema is needed for the given message options.
 * This function determines if:
 * 1. A schema is already registered and should be used
 * 2. No schema exists and needs to be provided
 * 3. No schema action is needed
 *
 * @param topicName - The Kafka topic name
 * @param options - The message options including schema, type, and payload
 * @param serdeType - Whether this is for key or value serialization
 * @param registry - The schema registry client instance (if used)
 * @returns An object describing the schema state, or null if no schema action is needed
 */
export async function checkSchemaNeeded(
  topicName: string,
  options: MessageOptions,
  serdeType: SerdeType,
  registry: SchemaRegistryClient | undefined,
): Promise<SchemaCheckResult> {
  if (options.useSchemaRegistry && !options.schema) {
    const subject =
      options.subject ||
      `${topicName}-${serdeType === SerdeType.KEY ? "key" : "value"}`;
    const latest = registry
      ? await getLatestSchemaIfExists(registry, subject)
      : null;
    if (!latest) {
      return { type: "no-schema", subject };
    }
  }
  return null;
}

/**
 * Fetches the latest schema string and schema type for a given subject from the schema registry.
 * Handles 404 errors gracefully by returning null when no schema exists.
 *
 * @param registry - The schema registry client instance
 * @param subject - The subject to look up in the registry
 * @returns An object with the latest schema string and schema type, or null if not found
 * @throws Error if there's an unexpected error from the registry
 */
export async function getLatestSchemaIfExists(
  registry: SchemaRegistryClient,
  subject: string,
): Promise<{ schema: string; schemaType: SchemaType } | null> {
  try {
    const latest = await registry.getLatestSchemaMetadata(subject);
    // The docs say that when no schemaType is supplied, it's assumed to be AVRO
    const schemaType = (latest.schemaType || "AVRO") as SchemaType;
    return { schema: latest.schema!, schemaType };
  } catch (err: unknown) {
    if (
      err &&
      typeof err === "object" &&
      "status" in err &&
      (err as { status?: number }).status === 404
    ) {
      return null;
    }
    throw err;
  }
}

/**
 * Fetches the latest registered schema for a subject and asserts it matches the
 * requested schema type. Without this guard a use-latest produce against a
 * subject registered with a different format fails deep inside the serializer
 * with an opaque parse/decode error (e.g. an AvroSerializer trying to parse a
 * JSON schema string, or the Protobuf path base64-decoding an Avro schema);
 * surfacing the mismatch here gives the caller an actionable message instead.
 *
 * @param registry - The schema registry client instance
 * @param subject - The resolved Schema Registry subject
 * @param expected - The schema type the caller asked to produce with
 * @returns The latest schema string and (matching) schema type
 * @throws Error if no schema is registered for the subject, or the registered
 *   schema type differs from `expected`
 */
export async function getLatestSchemaOfTypeOrThrow(
  registry: SchemaRegistryClient,
  subject: string,
  expected: SchemaType,
): Promise<{ schema: string; schemaType: SchemaType }> {
  const latest = await getLatestSchemaIfExists(registry, subject);
  if (!latest) {
    throw new Error(
      `No ${expected} schema registered for subject '${subject}', and none provided.`,
    );
  }
  if (latest.schemaType !== expected) {
    throw new Error(
      `Subject '${subject}' is registered as ${latest.schemaType}, but the requested schemaType is ${expected}. ` +
        `Use the matching schemaType, or produce to a different subject.`,
    );
  }
  return latest;
}

/**
 * Builds a `@bufbuild/protobuf` descriptor registry from raw `.proto` schema text.
 *
 * The `@confluentinc/schemaregistry` ProtobufSerializer encodes locally against
 * a descriptor registry, so we parse the `.proto` text with protobufjs, export
 * it to a canonical `FileDescriptorSet` (the standard `google.protobuf` wire
 * format), and read that into a registry. This is the path used when the caller
 * supplies the schema on a produce.
 *
 * @param protoText - The `.proto` schema definition (proto3)
 * @returns A mutable descriptor registry the serializer can consume
 * @throws Error if the `.proto` text cannot be parsed
 */
export function protobufRegistryFromProto(protoText: string): MutableRegistry {
  try {
    const root = protobuf.parse(protoText, { keepCase: true }).root;
    root.resolveAll();
    // protobufjs/ext/descriptor augments Root with toDescriptor at runtime but
    // does not declare it on the type, so narrow it locally.
    const toDescriptor = (
      root as unknown as {
        toDescriptor(
          syntax?: string,
        ): Parameters<typeof descriptor.FileDescriptorSet.encode>[0];
      }
    ).toDescriptor;
    const fileDescriptorSet = toDescriptor.call(root, "proto3");
    const bytes =
      descriptor.FileDescriptorSet.encode(fileDescriptorSet).finish();
    return createMutableRegistry(
      createFileRegistry(fromBinary(FileDescriptorSetSchema, bytes)),
    );
  } catch (err) {
    throw new Error(
      `Failed to parse Protobuf schema: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Builds a descriptor registry from a Protobuf schema as stored in Schema
 * Registry — a base64-encoded `FileDescriptorProto` (the "serialized" format
 * this SDK reads/writes). Used on the use-latest produce path, where the schema
 * was previously registered by the serializer rather than supplied as text.
 *
 * @param serializedSchema - base64-encoded `FileDescriptorProto`
 * @returns A mutable descriptor registry the serializer can consume
 * @throws Error if the stored schema cannot be decoded
 */
export function protobufRegistryFromSerialized(
  serializedSchema: string,
): MutableRegistry {
  try {
    const fileDescriptorProto = fromBinary(
      FileDescriptorProtoSchema,
      Buffer.from(serializedSchema, "base64"),
    );
    // Single self-contained file: no external dependencies to resolve.
    return createMutableRegistry(
      createFileRegistry(fileDescriptorProto, () => undefined),
    );
  } catch (err) {
    throw new Error(
      `Failed to decode registered Protobuf schema: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Converts a plain JS payload into a typed `@bufbuild/protobuf` message (carrying
 * the `$typeName` the ProtobufSerializer requires) using a descriptor registry.
 *
 * @param registry - Descriptor registry containing the target message type
 * @param messageName - Fully-qualified message type name (e.g. `com.example.User`)
 * @param payload - The payload to encode. Keys must match the proto field names
 *   exactly (e.g. `user_id`, not `userId`): the schema is parsed with protobufjs
 *   `keepCase: true`, so each field's JSON name equals its declared proto name
 *   and `fromJson` rejects camelCase keys as unknown fields.
 * @returns The typed protobuf message
 * @throws Error if `messageName` does not match a message in the registry (the
 *   error lists the available names)
 */
export function protobufMessageFrom(
  registry: MutableRegistry,
  messageName: string,
  payload: object,
): object {
  const messageDesc = registry.getMessage(messageName);
  if (!messageDesc) {
    const available: string[] = [];
    for (const type of registry) {
      if (type.kind === "message") {
        available.push(type.typeName);
      }
    }
    throw new Error(
      `Protobuf message type '${messageName}' not found in schema. ` +
        `Available message types: ${available.join(", ") || "(none)"}. ` +
        `Provide the fully-qualified name including the package (e.g. com.example.User).`,
    );
  }
  return fromJson(messageDesc, payload as Parameters<typeof fromJson>[1]);
}

/**
 * Bridges a raw `.proto` schema string and a plain JS payload into the form the
 * `@confluentinc/schemaregistry` {@link ProtobufSerializer} requires: a typed
 * message object (carrying `$typeName`) plus the descriptor registry describing
 * it. A plain object from tool input has neither, which is why it otherwise
 * fails with "message type name is empty". Convenience wrapper around
 * {@link protobufRegistryFromProto} + {@link protobufMessageFrom}.
 *
 * @param protoText - The `.proto` schema definition (proto3)
 * @param messageName - Fully-qualified message type name (e.g. `com.example.User`)
 * @param payload - The payload to encode. Keys must match the proto field names
 *   exactly (e.g. `user_id`, not `userId`) — see {@link protobufMessageFrom}.
 * @returns The typed protobuf message and the registry describing it
 * @throws Error if the `.proto` text cannot be parsed, or if `messageName` does
 *   not match a message in the schema
 */
export function buildProtobufMessage(
  protoText: string,
  messageName: string,
  payload: object,
): { message: object; registry: MutableRegistry } {
  const registry = protobufRegistryFromProto(protoText);
  const message = protobufMessageFrom(registry, messageName, payload);
  return { message, registry };
}

/**
 * Serializes a message using the provided options and schema registry configuration.
 * This function:
 * 1. Registers the schema if provided
 * 2. Validates the message type
 * 3. Creates the appropriate serializer
 * 4. Serializes the message
 *
 * @param topicName - The Kafka topic name
 * @param options - The message options including schema, type, and payload
 * @param serdeType - Whether this is for key or value serialization
 * @param registry - The schema registry client instance (if used)
 * @returns The serialized message as a Buffer or string
 * @throws Error if serialization fails, schema registration fails, or message type is invalid
 */
export async function serializeMessage(
  topicName: string,
  options: MessageOptions,
  serdeType: SerdeType,
  registry: SchemaRegistryClient | undefined,
): Promise<Buffer | string> {
  if (!options.useSchemaRegistry) {
    if (typeof options.message !== "string") {
      logger.warn(
        "Warning: Sending non-string message without schema registry. This may fail if the topic expects a schema.",
      );
    }
    return typeof options.message === "string"
      ? options.message
      : JSON.stringify(options.message);
  }
  if (!options.schemaType) {
    throw new Error("schemaType is required when useSchemaRegistry is true");
  }
  if (!registry) {
    throw new Error("Schema Registry client is required for serialization");
  }
  // Default subject naming
  const subject =
    options.subject ||
    `${topicName}-${serdeType === SerdeType.KEY ? "key" : "value"}`;

  // Validate message type
  if (typeof options.message !== "object" || options.message === null) {
    throw new Error(
      "When using schema registry, message must be an object matching the schema.",
    );
  }

  // Protobuf takes a separate path: the serializer encodes locally against a
  // @bufbuild/protobuf descriptor and registers/looks up the schema itself in
  // the "serialized" (base64 FileDescriptorProto) format that the deserializer
  // reads back. Registering raw .proto text here (the Avro/JSON path) would
  // produce bytes that fail to deserialize, so we don't reuse it.
  if (options.schemaType === "PROTOBUF") {
    return serializeProtobufMessage(
      topicName,
      subject,
      options,
      serdeType,
      registry,
    );
  }

  let schemaId: number | undefined;
  // Register schema if provided
  if (options.schema) {
    try {
      schemaId = await registry.register(
        subject,
        {
          schema: options.schema,
          schemaType: options.schemaType,
        },
        options.normalize,
      );
    } catch (err) {
      throw new Error(
        `Failed to register schema for subject '${subject}': ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    // Use-latest path: confirm the registered schema is the requested type so a
    // mismatch fails with an actionable message here rather than as an opaque
    // parse error inside the serializer's lazy useLatestVersion fetch.
    await getLatestSchemaOfTypeOrThrow(registry, subject, options.schemaType);
  }

  let serializer: Serializer;
  try {
    serializer = getSerializer(
      options.schemaType,
      registry,
      serdeType,
      schemaId,
    );
  } catch (err) {
    throw new Error(`Failed to get serializer: ${err}`);
  }
  try {
    return await serializer.serialize(topicName, options.message);
  } catch (err) {
    throw new Error(
      `Failed to serialize message for subject '${subject}': ${err}`,
    );
  }
}

/**
 * Serializes a Protobuf payload, registering or looking up the schema in the
 * format the SDK's deserializer can read back.
 *
 * - When the caller supplies the `.proto` text, the serializer auto-registers
 *   it (as a base64 `FileDescriptorProto`) and serializes.
 * - When no schema is supplied (use-latest), the previously-registered schema is
 *   fetched, its descriptor rebuilt from the stored serialized form, and the
 *   serializer uses the latest version.
 *
 * The payload is always converted into a typed `@bufbuild/protobuf` message
 * (carrying `$typeName`) before serialization.
 *
 * @param topicName - The Kafka topic name
 * @param subject - The resolved Schema Registry subject
 * @param options - The message options (must have `schemaType === "PROTOBUF"`)
 * @param registry - The schema registry client
 * @returns The serialized message bytes
 * @throws Error if `messageName` is missing, the schema is unavailable, or
 *   serialization fails
 */
async function serializeProtobufMessage(
  topicName: string,
  subject: string,
  options: MessageOptions,
  serdeType: SerdeType,
  registry: SchemaRegistryClient,
): Promise<Buffer> {
  if (!options.messageName) {
    throw new Error(
      "messageName is required when schemaType is PROTOBUF (e.g. com.example.User).",
    );
  }

  let protobufRegistry: MutableRegistry;
  let serializerConfig: SerializerConfig;
  if (options.schema) {
    // Provide path: let the serializer register the schema in the serialized
    // format the deserializer expects.
    protobufRegistry = protobufRegistryFromProto(options.schema);
    serializerConfig = {
      autoRegisterSchemas: true,
      normalizeSchemas: Boolean(options.normalize),
    };
  } else {
    // Use-latest path: rebuild the descriptor from the stored serialized schema.
    const latest = await getLatestSchemaOfTypeOrThrow(
      registry,
      subject,
      "PROTOBUF",
    );
    protobufRegistry = protobufRegistryFromSerialized(latest.schema);
    serializerConfig = { useLatestVersion: true };
  }

  const message = protobufMessageFrom(
    protobufRegistry,
    options.messageName,
    options.message as object,
  );

  const serializer = new ProtobufSerializer(registry, serdeType, {
    ...serializerConfig,
    registry: protobufRegistry,
  });
  try {
    return await serializer.serialize(topicName, message);
  } catch (err) {
    throw new Error(
      `Failed to serialize message for subject '${subject}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Deserializes a message using Schema Registry.
 * This function:
 * 1. Creates the appropriate deserializer
 * 2. Deserializes the message using the schema from the registry
 *
 * @param topic - The Kafka topic name
 * @param message - The message buffer to deserialize
 * @param schemaType - The schema type (AVRO, JSON, PROTOBUF)
 * @param registry - The schema registry client
 * @param serdeType - Whether this is key or value
 * @returns The deserialized object
 * @throws Error if deserialization fails
 */
export async function deserializeMessage(
  topic: string,
  message: Buffer,
  schemaType: SchemaType,
  registry: SchemaRegistryClient,
  serdeType: SerdeType,
): Promise<unknown> {
  try {
    const deserializer = getDeserializer(schemaType, registry, serdeType);
    return await deserializer.deserialize(topic, message);
  } catch (err) {
    throw new Error(`Failed to deserialize message: ${err}`);
  }
}
