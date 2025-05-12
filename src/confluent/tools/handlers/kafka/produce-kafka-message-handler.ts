import { RecordMetadata } from "@confluentinc/kafka-javascript/types/kafkajs.js";
import { SchemaRegistryClient, SerdeType } from "@confluentinc/schemaregistry";
import { ClientManager } from "@src/confluent/client-manager.js";
import {
  checkSchemaNeeded,
  MessageOptions,
  SchemaCheckResult,
  serializeMessage,
} from "@src/confluent/schema-registry-helper.js";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { EnvVar } from "@src/env-schema.js";
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
   * Handles the result of a schema check, returning a CallToolResult if a schema issue is found, or null otherwise.
   * @param result - The schema check result to handle
   * @returns A CallToolResult if a schema issue is found, or null otherwise
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
   * @param clientManager - The client manager for Kafka and registry clients
   * @param toolArguments - The arguments for the tool, including topic, value, and key
   * @returns A CallToolResult describing the outcome of the produce operation
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
    const valueSchemaCheck = await checkSchemaNeeded(
      topicName,
      value as MessageOptions,
      SerdeType.VALUE,
      registry,
    );
    const valueSchemaResult = this.handleSchemaCheckResult(valueSchemaCheck);
    if (valueSchemaResult) return valueSchemaResult;

    // Check for latest schema if needed (key)
    if (key) {
      const keySchemaCheck = await checkSchemaNeeded(
        topicName,
        key as MessageOptions,
        SerdeType.KEY,
        registry,
      );
      const keySchemaResult = this.handleSchemaCheckResult(keySchemaCheck);
      if (keySchemaResult) return keySchemaResult;
    }

    let valueToSend: Buffer | string;
    let keyToSend: Buffer | string | undefined;
    try {
      valueToSend = await serializeMessage(
        topicName,
        value as MessageOptions,
        SerdeType.VALUE,
        registry,
      );
      if (key) {
        keyToSend = await serializeMessage(
          topicName,
          key as MessageOptions,
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

  /**
   * Returns the tool configuration including name, description, and input schema.
   * @returns The tool configuration
   */
  getToolConfig(): ToolConfig {
    return {
      name: ToolName.PRODUCE_MESSAGE,
      description: `Produce records to a Kafka topic. Supports Confluent Schema Registry serialization (AVRO, JSON, PROTOBUF) for both key and value.\n\nBefore producing, check if the topic has a registered schema for <topicName>-value and <topicName>-key. If a schema exists, set useSchemaRegistry to true and specify the appropriate schemaType. For saving user messages/history, use the kafka topic named mcp-conversations unless otherwise specified. If the topic does not exist, it can be created via the ${ToolName.CREATE_TOPICS} tool.`,
      inputSchema: produceKafkaMessageArguments.shape,
    };
  }

  getRequiredEnvVars(): EnvVar[] {
    return ["KAFKA_API_KEY", "KAFKA_API_SECRET", "BOOTSTRAP_SERVERS"];
  }
}
