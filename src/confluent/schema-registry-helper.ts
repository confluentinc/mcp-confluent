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

/**
 * Supported schema types for Confluent Schema Registry
 */
export type SchemaType = "AVRO" | "JSON" | "PROTOBUF";

/**
 * Common options for schema registry operations
 */
export interface SchemaRegistryOptions {
  useSchemaRegistry?: boolean;
  schemaType?: SchemaType;
  schema?: string;
  subject?: string;
  normalize?: boolean;
}

export type MessageOptions = {
  message: Buffer | object | string;
  useSchemaRegistry?: boolean;
  schemaType?: SchemaType;
  schema?: string;
  subject?: string;
  normalize?: boolean;
};

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
 * Returns the appropriate serializer instance for the given schema type
 * @param schemaType The type of schema (AVRO, JSON, PROTOBUF)
 * @param registry The schema registry client instance
 * @param serdeType Whether this is for key or value serialization
 * @param schemaId Optional schema ID to use for serialization
 * @returns The appropriate Serializer instance
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
 * Returns the appropriate deserializer instance for the given schema type
 * @param schemaType The type of schema (AVRO, JSON, PROTOBUF)
 * @param registry The schema registry client instance
 * @param serdeType Whether this is for key or value deserialization
 * @returns The appropriate Deserializer instance
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
 * Checks if a schema is needed for the given message options and returns a result describing the schema state.
 * @param topicName The Kafka topic name.
 * @param options The message options including schema, type, and payload.
 * @param serdeType Whether this is for key or value serialization.
 * @param registry The schema registry client instance (if used).
 * @returns An object describing the schema state, or null if no schema action is needed.
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
 * Fetches the latest schema string and schema type for a given subject from the schema registry
 * @param registry The schema registry client instance
 * @param subject The subject to look up in the registry
 * @returns An object with the latest schema string and schema type, or null if not found
 */
export async function getLatestSchemaIfExists(
  registry: SchemaRegistryClient,
  subject: string,
): Promise<{ schema: string; schemaType: SchemaType } | null> {
  try {
    const latest = await registry.getLatestSchemaMetadata(subject);
    console.error(`[getLatestSchemaIfExists] Latest schema: ${latest}`);
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
      console.error(
        `[getLatestSchemaIfExists] Schema not found for subject: ${subject}`,
      );
      console.error(`[getLatestSchemaIfExists] Error: ${err}`);
      return null;
    }
    throw err;
  }
}

/**
 * Serializes a message using the provided options and schema registry configuration.
 * Registers the schema if provided, and validates the message type.
 * @param topicName The Kafka topic name.
 * @param options The message options including schema, type, and payload.
 * @param serdeType Whether this is for key or value serialization.
 * @param registry The schema registry client instance (if used).
 * @returns The serialized message as a Buffer or string.
 * @throws If serialization or registration fails, or if the message type is invalid.
 */
export async function serializeMessage(
  topicName: string,
  options: MessageOptions,
  serdeType: SerdeType,
  registry: SchemaRegistryClient | undefined,
): Promise<Buffer | string> {
  if (!options.useSchemaRegistry) {
    if (typeof options.message !== "string") {
      console.warn(
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
 * Deserializes a message using Schema Registry
 * @param topic The Kafka topic name
 * @param message The message buffer to deserialize
 * @param schemaType The schema type (AVRO, JSON, PROTOBUF)
 * @param registry The schema registry client
 * @param serdeType Whether this is key or value
 * @returns The deserialized object
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
