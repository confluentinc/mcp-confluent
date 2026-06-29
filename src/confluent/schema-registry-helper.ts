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
import { IHeaders } from "@confluentinc/kafka-javascript/types/kafkajs.js";
import {
  AvroDeserializer,
  AvroSerializer,
  Deserializer,
  DeserializerConfig,
  HeaderSchemaIdSerializer,
  JsonDeserializer,
  JsonSerializer,
  ProtobufDeserializer,
  ProtobufSerializer,
  ProtobufSerializerConfig,
  SchemaId,
  SchemaRegistryClient,
  SerdeType,
  Serializer,
  SerializerConfig,
} from "@confluentinc/schemaregistry";
import { logger } from "@src/logger.js";
import protobuf from "protobufjs";
import descriptor from "protobufjs/ext/descriptor/index.js";

/**
 * Where the Schema Registry schema ID rides on the wire. "payload" embeds it as
 * magic bytes at the front of the serialized payload (the default Confluent
 * wire format); "header" writes the schema GUID to the __value_schema_id /
 * __key_schema_id Kafka record header and leaves the payload as bare bytes.
 */
export type SchemaIdLocation = "payload" | "header";

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
  schemaIdLocation?: SchemaIdLocation;
}

/**
 * Options for message serialization/deserialization.
 * Includes the message payload and schema registry configuration.
 */
export type MessageOptions = {
  message: Buffer | object | string | number | boolean;
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
  schemaIdLocation?: SchemaIdLocation;
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
 *
 * This is a pure factory: it maps a {@link SchemaType} to its serializer
 * constructor and forwards the caller-built {@link SerializerConfig}. The
 * format-specific *decisions* — schema-id vs. use-latest for AVRO/JSON, plus the descriptor registry for PROTOBUF — live
 * with the callers ({@link serializeMessage}, {@link serializeProtobufMessage}),
 * which is why the config arrives ready-made. For PROTOBUF the descriptor
 * registry rides inside the config as its optional `registry` field
 * (`ProtobufSerializerConfig = SerializerConfig & { registry?: MutableRegistry }`).
 *
 * @param schemaType - The type of schema (AVRO, JSON, PROTOBUF)
 * @param registry - The schema registry client instance
 * @param serdeType - Whether this is for key or value serialization
 * @param serializerConfig - The serializer configuration to forward (use-latest,
 *   use-schema-id, the optional `schemaIdLocation` header serializer, and/or the
 *   PROTOBUF descriptor registry)
 * @returns The appropriate Serializer instance
 * @throws Error if the schema type is unknown or unsupported
 */
export function getSerializer(
  schemaType: SchemaType | undefined,
  registry: SchemaRegistryClient,
  serdeType: SerdeType,
  serializerConfig: SerializerConfig,
): Serializer {
  const serializers = {
    AVRO: () => new AvroSerializer(registry, serdeType, serializerConfig),
    JSON: () => new JsonSerializer(registry, serdeType, serializerConfig),
    PROTOBUF: () =>
      new ProtobufSerializer(registry, serdeType, serializerConfig),
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
    // protobufjs/ext/descriptor exposes FileDescriptorSet and augments Root with
    // toDescriptor at runtime, but v8's bundled types no longer declare either on
    // the exported shape, so narrow both locally.
    const FileDescriptorSet = (
      descriptor as unknown as {
        FileDescriptorSet: {
          encode(message: object): { finish(): Uint8Array };
        };
      }
    ).FileDescriptorSet;
    const toDescriptor = (
      root as unknown as {
        toDescriptor(
          syntax?: string,
        ): Parameters<typeof FileDescriptorSet.encode>[0];
      }
    ).toDescriptor;
    const fileDescriptorSet = toDescriptor.call(root, "proto3");
    const bytes = FileDescriptorSet.encode(fileDescriptorSet).finish();
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
 * Serialize a message when Schema Registry is not in use: a string passes
 * through verbatim, anything else is JSON-encoded. Warns on a non-string
 * payload, which a schema-bearing topic will likely reject.
 */
function serializeWithoutSchemaRegistry(
  message: MessageOptions["message"],
): string {
  if (typeof message !== "string") {
    logger.warn(
      "Warning: Sending non-string message without schema registry. This may fail if the topic expects a schema.",
    );
  }
  return typeof message === "string" ? message : JSON.stringify(message);
}

/**
 * Validate the preconditions for Schema Registry serialization, narrowing
 * `registry` to non-undefined for the caller. Throws an actionable error when
 * the schema type is missing, no registry client is configured, or header
 * mode was requested without a record-header accumulator. The
 * HeaderSchemaIdSerializer writes the schema-id header into the headers object
 * it's handed; with no accumulator the library otherwise throws a cryptic
 * "Missing Headers", so fail fast here instead.
 */
function assertSchemaRegistrySerializable(
  options: MessageOptions,
  registry: SchemaRegistryClient | undefined,
  recordHeaders: IHeaders | undefined,
): asserts registry is SchemaRegistryClient {
  if (!options.schemaType) {
    throw new Error("schemaType is required when useSchemaRegistry is true");
  }
  if (!registry) {
    throw new Error("Schema Registry client is required for serialization");
  }
  if (options.schemaIdLocation === "header" && !recordHeaders) {
    throw new Error(
      "schemaIdLocation 'header' requires a record-header accumulator to write the schema-id header into.",
    );
  }
}

/**
 * Register the caller-supplied schema under `subject` and return its assigned
 * id, or undefined when no schema was supplied (the use-latest path). Wraps a
 * registration failure in a subject-scoped error.
 */
async function registerSchemaIfProvided(
  registry: SchemaRegistryClient,
  subject: string,
  options: MessageOptions,
): Promise<number | undefined> {
  if (!options.schema) {
    return undefined;
  }
  try {
    return await registry.register(
      subject,
      {
        schema: options.schema,
        schemaType: options.schemaType,
      },
      options.normalize,
    );
  } catch (err) {
    throw new Error(
      `Failed to register schema for subject '${subject}': ${err}`,
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
 * @param payload - The payload to encode. Keys may use either the proto field
 *   name (`user_id`) or its auto-generated camelCase JSON name (`userId`):
 *   `fromJson` accepts both and maps them onto the same field. Keys that match
 *   neither are rejected as unknown fields.
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
 * @param recordHeaders - Mutable record-header accumulator. Required for
 *   `schemaIdLocation: "header"`, where the serializer writes the schema-id
 *   header into it; ignored by the payload format and the raw (non-registry) path.
 * @returns The serialized message as a Buffer or string
 * @throws Error if serialization fails, schema registration fails, or message type is invalid
 */
export async function serializeMessage(
  topicName: string,
  options: MessageOptions,
  serdeType: SerdeType,
  registry: SchemaRegistryClient | undefined,
  recordHeaders?: IHeaders,
): Promise<Buffer | string> {
  if (!options.useSchemaRegistry) {
    return serializeWithoutSchemaRegistry(options.message);
  }
  assertSchemaRegistrySerializable(options, registry, recordHeaders);

  const subject =
    options.subject ||
    `${topicName}-${serdeType === SerdeType.KEY ? "key" : "value"}`;
  const schemaId = await registerSchemaIfProvided(registry, subject, options);

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

  // Primitives (number/boolean/string) are valid payloads for top-level
  // primitive schemas (e.g. Avro "long"); only null/undefined is rejected here
  // because the serializer refuses it with a cryptic "message is empty". Every
  // other shape is validated against the actual schema by the serializer.
  // Validate the payload before any registry lookup below.
  if (options.message === null || options.message === undefined) {
    throw new Error(
      "When using schema registry, a non-null message payload is required.",
    );
  }

  // Use-latest path (no schema supplied): confirm the registered schema is the
  // requested type so a mismatch fails with an actionable message here rather
  // than as an opaque parse error inside the serializer's lazy useLatestVersion
  // fetch.
  if (schemaId === undefined && options.schemaType) {
    await getLatestSchemaOfTypeOrThrow(registry, subject, options.schemaType);
  }

  const serializerConfig: SerializerConfig =
    typeof schemaId === "number"
      ? { useSchemaId: schemaId }
      : { useLatestVersion: true };
  if (options.schemaIdLocation === "header") {
    serializerConfig.schemaIdSerializer = HeaderSchemaIdSerializer;
  }

  let serializer: Serializer;
  try {
    serializer = getSerializer(
      options.schemaType,
      registry,
      serdeType,
      serializerConfig,
    );
  } catch (err) {
    throw new Error(`Failed to get serializer: ${err}`);
  }
  try {
    return await serializer.serialize(
      topicName,
      options.message,
      recordHeaders,
    );
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

  // Header schema-id mode isn't supported for PROTOBUF yet, so reject it
  // explicitly: otherwise the produce would silently fall back to the payload
  // wire format and write a message that doesn't match what the caller asked
  // for. Header support for AVRO/JSON landed in #607; protobuf parity is a
  // separate follow-up in #633.
  if (options.schemaIdLocation === "header") {
    throw new Error(
      "schemaIdLocation 'header' is not supported for PROTOBUF yet; use the default payload format.",
    );
  }

  let protobufRegistry: MutableRegistry;
  let serializerConfig: SerializerConfig;
  if (options.schema) {
    // Provide path: the serializer registers the schema in the binary format
    // the deserializer expects. subjectNameStrategy overrides TopicNameStrategy
    // so the serializer uses the caller-resolved subject instead of deriving
    // one from the topic name.
    protobufRegistry = protobufRegistryFromProto(options.schema);
    serializerConfig = {
      normalizeSchemas: Boolean(options.normalize),
      autoRegisterSchemas: true,
      subjectNameStrategy: () => subject,
    };
  } else {
    // Use-latest path: rebuild the descriptor from the stored serialized schema.
    const latest = await getLatestSchemaOfTypeOrThrow(
      registry,
      subject,
      "PROTOBUF",
    );
    protobufRegistry = protobufRegistryFromSerialized(latest.schema);
    serializerConfig = {
      useLatestVersion: true,
      subjectNameStrategy: () => subject,
    };
  }

  const message = protobufMessageFrom(
    protobufRegistry,
    options.messageName,
    options.message as object,
  );

  // The descriptor registry rides inside the config: ProtobufSerializer reads
  // its optional `registry` field to encode locally. getSerializer forwards the
  // whole config, so PROTOBUF flows through the same factory as AVRO/JSON.
  const protobufConfig: ProtobufSerializerConfig = {
    ...serializerConfig,
    registry: protobufRegistry,
  };
  const serializer = getSerializer(
    "PROTOBUF",
    registry,
    serdeType,
    protobufConfig,
  );
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
 * @param headers - Raw record headers. When present, the default dual
 *   deserializer reads a header-located schema ID (__value_schema_id /
 *   __key_schema_id) before falling back to the magic-byte prefix.
 * @returns The deserialized object
 * @throws Error if deserialization fails
 */
export async function deserializeMessage(
  topic: string,
  message: Buffer,
  schemaType: SchemaType,
  registry: SchemaRegistryClient,
  serdeType: SerdeType,
  headers?: IHeaders,
): Promise<unknown> {
  try {
    const deserializer = getDeserializer(schemaType, registry, serdeType);
    return await deserializer.deserialize(topic, message, headers);
  } catch (err) {
    throw new Error(`Failed to deserialize message: ${err}`);
  }
}

/**
 * Decode a header-located schema-id record-header value into its canonical
 * schema GUID string. The header wire format (written by the serde library's
 * HeaderSchemaIdSerializer) is MAGIC_BYTE_V1 followed by the 16-byte GUID; the
 * schema type only governs the Protobuf message-index tail that the GUID read
 * ignores, so a fixed type is safe here. Returns null when the bytes aren't a
 * recognizable GUID header (e.g. a payload-format magic-byte-0 buffer, or
 * garbage), letting the caller fall back to echoing the raw value.
 */
export function decodeSchemaGuidHeader(headerValue: Buffer): string | null {
  try {
    const schemaId = new SchemaId("AVRO");
    schemaId.fromBytes(headerValue);
    return schemaId.guid ?? null;
  } catch {
    return null;
  }
}
