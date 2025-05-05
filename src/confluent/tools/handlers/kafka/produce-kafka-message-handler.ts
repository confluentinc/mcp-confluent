import { RecordMetadata } from "@confluentinc/kafka-javascript/types/kafkajs.js";
import {
  AvroSerializer,
  JsonSerializer,
  ProtobufSerializer,
  SchemaRegistryClient,
  SerdeType,
  Serializer,
  SerializerConfig,
} from "@confluentinc/schemaregistry";
import { ClientManager } from "@src/confluent/client-manager.js";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { z } from "zod";

const messageOptions = z.object({
  message: z
    .union([z.object({}).passthrough(), z.string()])
    .describe(
      "The payload to produce. If using schema registry, this should be an object matching the schema. Otherwise, a string.",
    ),
  useSchemaRegistry: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "If true, use schema registry for serialization. If false, send as raw string/JSON.",
    ),
  schemaType: z
    .enum(["AVRO", "JSON", "PROTOBUF"])
    .optional()
    .describe("Schema type to use. If omitted, sends as raw string/JSON."),
  schema: z
    .string()
    .optional()
    .describe(
      "Schema definition to register (as JSON string for AVRO/JSON, or .proto for PROTOBUF). If omitted, uses latest registered schema.",
    ),
  subject: z
    .string()
    .optional()
    .describe(
      "Schema Registry subject. Defaults to {topicName}-value or {topicName}-key.",
    ),
  normalize: z.boolean().optional(),
});

type MessageOptions = z.infer<typeof messageOptions>;
const valueOptions = z.object({}).extend(messageOptions.shape);
const keyOptions = z.object({}).extend(messageOptions.shape);

const produceKafkaMessageArguments = z.object({
  topicName: z
    .string()
    .nonempty()
    .describe("Name of the kafka topic to produce the message to"),
  value: valueOptions,
  key: keyOptions.optional(),
});
type ProduceKafkaMessageArguments = z.infer<
  typeof produceKafkaMessageArguments
>;

type SchemaCheckResult =
  | {
      type: "schema-needed";
      latestSchema: string;
      subject: string;
      schemaType: string;
    }
  | { type: "no-schema"; subject: string }
  | null;

/**
 * Handler for producing messages to a Kafka topic, with support for Confluent Schema Registry serialization (AVRO, JSON, PROTOBUF) for both key and value.
 *
 * - If schema registry is enabled, the handler checks if a schema is already registered for the topic's key/value subject.
 *   - If a schema exists and none is provided, it returns the latest schema to the client for retry.
 *   - If no schema exists and none is provided, it returns an error.
 *   - If a schema is provided, it is registered before serialization.
 * - Serialization is performed using the appropriate serializer for the schema type.
 * - Produces the message to the specified Kafka topic, handling both key and value serialization as needed.
 */
export class ProduceKafkaMessageHandler extends BaseToolHandler {
  /**
   * Returns the appropriate serializer instance for the given schema type, registry, and serde type.
   * @param schemaType The type of schema (AVRO, JSON, PROTOBUF).
   * @param registry The schema registry client instance.
   * @param serdeType Whether this is for key or value serialization.
   * @param schemaId (Optional) The schema ID to use for serialization. If not provided, uses the latest version.
   * @returns The appropriate Serializer instance.
   * @throws If the schema type is unknown.
   */
  getSerializer(
    schemaType: MessageOptions["schemaType"],
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
   * Fetches the latest schema string and schema type for a given subject from the schema registry, or null if not found.
   * @param registry The schema registry client instance.
   * @param subject The subject to look up in the registry.
   * @returns An object with the latest schema string and schema type, or null if not found.
   * @throws If an error occurs other than not found.
   */
  async getLatestSchemaIfExists(
    registry: SchemaRegistryClient,
    subject: string,
  ): Promise<{ schema: string; schemaType: string } | null> {
    try {
      const latest = await registry.getLatestSchemaMetadata(subject);
      // the docs say that when no schemaType is supplied, its assumed to be AVRO
      // See: https://docs.confluent.io/platform/current/schema-registry/develop/api.html#get--subjects-(string-%20subject)-versions-(versionId-%20version)
      const schemaType = latest.schemaType || "AVRO";
      console.error(
        `Latest schema for subject '${subject}': ${latest.schema}, schemaType: ${schemaType}`,
      );
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
   * Registers the schema if provided, and validates the message type.
   * @param topicName The Kafka topic name.
   * @param options The message options including schema, type, and payload.
   * @param serdeType Whether this is for key or value serialization.
   * @param registry The schema registry client instance (if used).
   * @returns The serialized message as a Buffer or string.
   * @throws If serialization or registration fails, or if the message type is invalid.
   */
  async serializeMessage(
    topicName: string,
    options: MessageOptions,
    serdeType: SerdeType,
    registry: SchemaRegistryClient | undefined,
  ): Promise<Buffer | string> {
    if (!options.useSchemaRegistry) {
      // Warn if topic is known to require schema (not implemented: topic config check)
      // For now, just warn in the response
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
      console.error(
        `Registering schema '${options.schema}' for subject '${subject}'`,
      );
      try {
        schemaId = await registry.register(
          subject,
          {
            schema: options.schema,
            schemaType: options.schemaType,
          },
          options.normalize,
        );
        console.error(`Schema registered with ID ${schemaId}`);
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
      serializer = this.getSerializer(
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
   * Checks if a schema is needed for the given message options and returns a result describing the schema state.
   * @param topicName The Kafka topic name.
   * @param options The message options including schema, type, and payload.
   * @param serdeType Whether this is for key or value serialization.
   * @param registry The schema registry client instance (if used).
   * @returns An object describing the schema state, or null if no schema action is needed.
   */
  async checkSchemaNeeded(
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
        ? await this.getLatestSchemaIfExists(registry, subject)
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
   * Handles the result of a schema check, returning a CallToolResult if a schema issue is found, or null otherwise.
   * @param result The schema check result to handle.
   * @returns A CallToolResult if a schema issue is found, or null otherwise.
   */
  handleSchemaCheckResult(result: SchemaCheckResult): CallToolResult | null {
    if (!result) return null;

    if (result.type === "schema-needed") {
      return this.createResponse(
        `A schema already exists for subject '${result.subject}'. Please retry with the following schema:\n${result.latestSchema}, schemaType: ${result.schemaType}`,
        true,
        {
          latestSchema: result.latestSchema,
          subject: result.subject,
          schemaType: result.schemaType,
        },
      );
    } else {
      return this.createResponse(
        `No schema registered for subject '${result.subject}', and no schema provided to register.`,
        true,
      );
    }
  }

  /**
   * Main handler for producing a message to a Kafka topic, including schema registry logic and serialization.
   * Handles both value and key, and returns a CallToolResult with the outcome.
   * @param clientManager The client manager for Kafka and registry clients.
   * @param toolArguments The arguments for the tool, including topic, value, and key.
   * @returns A CallToolResult describing the outcome of the produce operation.
   */
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const { topicName, value, key }: ProduceKafkaMessageArguments =
      produceKafkaMessageArguments.parse(toolArguments);

    // Only create registry if needed
    const needsRegistry =
      value.useSchemaRegistry || (key && key.useSchemaRegistry);
    const registry: SchemaRegistryClient | undefined = needsRegistry
      ? clientManager.getSchemaRegistryClient()
      : undefined;

    // Check for latest schema if needed (value)
    const valueSchemaCheck = await this.checkSchemaNeeded(
      topicName,
      value,
      SerdeType.VALUE,
      registry,
    );
    const valueSchemaResult = this.handleSchemaCheckResult(valueSchemaCheck);
    if (valueSchemaResult) return valueSchemaResult;

    // Check for latest schema if needed (key)
    if (key) {
      const keySchemaCheck = await this.checkSchemaNeeded(
        topicName,
        key,
        SerdeType.KEY,
        registry,
      );
      const keySchemaResult = this.handleSchemaCheckResult(keySchemaCheck);
      if (keySchemaResult) return keySchemaResult;
    }

    let valueToSend: Buffer | string;
    let keyToSend: Buffer | string | undefined;
    try {
      valueToSend = await this.serializeMessage(
        topicName,
        value,
        SerdeType.VALUE,
        registry,
      );
      if (key) {
        keyToSend = await this.serializeMessage(
          topicName,
          key,
          SerdeType.KEY,
          registry,
        );
      }
    } catch (err) {
      return this.createResponse(
        `Failed to serialize: ${err instanceof Error ? err.message : err}`,
        true,
      );
    }

    // Send the message
    let deliveryReport: RecordMetadata[];
    try {
      deliveryReport = await (
        await clientManager.getProducer()
      ).send({
        topic: topicName,
        messages: [
          typeof keyToSend !== "undefined"
            ? { key: keyToSend, value: valueToSend }
            : { value: valueToSend },
        ],
      });
    } catch (err) {
      return this.createResponse(
        `Failed to produce message: ${err instanceof Error ? err.message : err}`,
        true,
      );
    }
    const formattedResponse = deliveryReport
      .map((metadata) => {
        if (metadata.errorCode !== 0) {
          return `Error producing message to [Topic: ${metadata.topicName}, Partition: ${metadata.partition}, Offset: ${metadata.offset} with ErrorCode: ${metadata.errorCode}]`;
        }
        return `Message produced successfully to [Topic: ${metadata.topicName}, Partition: ${metadata.partition}, Offset: ${metadata.offset}]`;
      })
      .join("\n");
    const isError = deliveryReport.some((metadata) => metadata.errorCode !== 0);
    return this.createResponse(formattedResponse, isError);
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.PRODUCE_MESSAGE,
      description: `Produce records to a Kafka topic. Supports Confluent Schema Registry serialization (AVRO, JSON, PROTOBUF) for both key and value.\n\nBefore producing, check if the topic has a registered schema for <topicName>-value and <topicName>-key. If a schema exists, set useSchemaRegistry to true and specify the appropriate schemaType. For saving user messages/history, use the kafka topic named mcp-conversations unless otherwise specified. If the topic does not exist, it can be created via the ${ToolName.CREATE_TOPICS} tool.`,
      inputSchema: produceKafkaMessageArguments.shape,
    };
  }
}
