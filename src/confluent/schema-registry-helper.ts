/**
 * This module provides helper functions for working with Confluent Schema Registry.
 * It handles schema registration, serialization, and deserialization of messages
 * using various schema formats (AVRO, JSON, PROTOBUF).
 */

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
};

/**
 * Result of checking if a schema is needed for a message.
 * Can indicate:
 * - A schema is needed and provides the latest schema details
 * - No schema exists and needs to be provided
 * - No schema action is needed
 */
export type SchemaCheckResult =
  | {
      type: "schema-needed";
      latestSchema: string;
      subject: string;
      schemaType: string;
    }
  | { type: "no-schema"; subject: string }
  | null;

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
    if (latest) {
      return {
        type: "schema-needed",
        latestSchema: latest.schema,
        subject,
        schemaType: latest.schemaType,
      };
    } else {
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
        `Failed to register schema for subject '${subject}': ${err}`,
      );
    }
  }
  // Validate message type
  if (typeof options.message !== "object" || options.message === null) {
    throw new Error(
      "When using schema registry, message must be an object matching the schema.",
    );
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
