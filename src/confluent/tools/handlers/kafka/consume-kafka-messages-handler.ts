import { KafkaJS } from "@confluentinc/kafka-javascript";
import { KafkaMessage } from "@confluentinc/kafka-javascript/types/kafkajs.js";
import { SchemaRegistryClient, SerdeType } from "@confluentinc/schemaregistry";
import { ClientManager } from "@src/confluent/client-manager.js";
import {
  deserializeMessage,
  getLatestSchemaIfExists,
} from "@src/confluent/schema-registry-helper.js";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { logger } from "@src/logger.js";
import { z } from "zod";

const messageOptions = z.object({
  useSchemaRegistry: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Whether to use schema registry for deserialization. If false, messages will be returned as raw.",
    ),
  subject: z
    .string()
    .optional()
    .describe(
      "Schema registry subject. Defaults to 'topicName-value' or 'topicName-key'.",
    ),
});

const valueOptions = z.object({}).extend(messageOptions.shape);
const keyOptions = z.object({}).extend(messageOptions.shape);

type ValueOptions = z.infer<typeof valueOptions>;
type KeyOptions = z.infer<typeof keyOptions>;

export const consumeKafkaMessagesArgs = z.object({
  topicNames: z
    .array(z.string())
    .nonempty()
    .describe("Names of the Kafka topics to consume from."),
  maxMessages: z
    .number()
    .int()
    .positive()
    .optional()
    .default(10)
    .describe("Maximum number of messages to consume before stopping."),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .default(10000)
    .describe(
      "Maximum time in milliseconds to wait for messages before stopping.",
    ),
  value: valueOptions,
  key: keyOptions.optional(),
});

interface ProcessedMessage {
  key: unknown;
  value: unknown;
  timestamp: string;
  offset: string;
  headers?: Record<string, string>;
  topic: string;
  partition: number;
}

/**
 * Handler for consuming messages from Kafka topics with support for Schema Registry deserialization.
 * This handler allows consuming messages from one or more topics with configurable message limits and timeouts.
 * It supports automatic deserialization of Schema Registry encoded messages (AVRO, JSON, PROTOBUF).
 */
export class ConsumeKafkaMessagesHandler extends BaseToolHandler {
  /**
   * Processes a single Kafka message, handling deserialization of both key and value.
   * @param topic - The topic the message was consumed from
   * @param partition - The partition the message was consumed from
   * @param message - The raw Kafka message
   * @param registry - Optional Schema Registry client for deserialization
   * @param valueOptions - Options for value deserialization
   * @param keyOptions - Optional options for key deserialization
   * @returns A processed message with deserialized key and value
   */
  async processMessage(
    topic: string,
    partition: number,
    message: KafkaMessage,
    registry: SchemaRegistryClient | undefined,
    valueOptions: ValueOptions,
    keyOptions?: KeyOptions,
  ): Promise<ProcessedMessage> {
    let processedKey: unknown = message.key?.toString();
    let processedValue: unknown = message.value?.toString();

    const deserializeWithOptions = async (
      buffer: Buffer | undefined,
      options: ValueOptions | KeyOptions,
      serdeType: SerdeType,
    ): Promise<unknown> => {
      if (!options.useSchemaRegistry || !registry) {
        return buffer?.toString();
      }
      const subject =
        options.subject ||
        `${topic}-${serdeType === SerdeType.KEY ? "key" : "value"}`;
      const schema = await getLatestSchemaIfExists(registry, subject);
      if (!schema || !schema.schemaType) {
        return buffer?.toString();
      }
      try {
        return await deserializeMessage(
          topic,
          buffer as Buffer,
          schema.schemaType,
          registry,
          serdeType,
        );
      } catch (err) {
        logger.error(
          { error: err, topic, schemaType: schema.schemaType, serdeType },
          `Error deserializing message ${serdeType} for topic ${topic}`,
        );
        return buffer?.toString();
      }
    };

    processedValue = await deserializeWithOptions(
      message.value as Buffer,
      valueOptions,
      SerdeType.VALUE,
    );
    if (message.key && keyOptions) {
      processedKey = await deserializeWithOptions(
        message.key as Buffer,
        keyOptions,
        SerdeType.KEY,
      );
    }

    return {
      key: processedKey,
      value: processedValue,
      timestamp: message.timestamp,
      offset: message.offset,
      headers: message.headers
        ? Object.fromEntries(
            Object.entries(message.headers).map(([key, value]) => [
              key,
              value?.toString() || "",
            ]),
          )
        : undefined,
      topic,
      partition,
    };
  }

  /**
   * Main handler for consuming messages from Kafka topics.
   * @param clientManager - The client manager for Kafka and registry clients
   * @param toolArguments - The arguments for the tool, including topics, message limits, and deserialization options
   * @returns A CallToolResult containing the consumed messages or error information
   */
  async handle(
    clientManager: ClientManager,
    toolArguments: z.infer<typeof consumeKafkaMessagesArgs>,
  ): Promise<CallToolResult> {
    const { topicNames, maxMessages, timeoutMs, value, key } =
      consumeKafkaMessagesArgs.parse(toolArguments);

    const consumedMessages: ProcessedMessage[] = [];
    let timeoutReached = false;
    let consumer: KafkaJS.Consumer | undefined;
    const registry: SchemaRegistryClient | undefined =
      value.useSchemaRegistry || (key && key.useSchemaRegistry)
        ? clientManager.getSchemaRegistryClient()
        : undefined;

    try {
      consumer = await clientManager.getConsumer();
      await consumer.connect();
      await consumer.subscribe({ topics: topicNames });

      const consumePromise = new Promise<void>((resolve, reject) => {
        if (!consumer) {
          reject(new Error("Consumer was unexpectedly undefined"));
          return;
        }
        consumer
          .run({
            eachMessage: async ({ topic, partition, message }) => {
              if (timeoutReached) return;
              const processed = await this.processMessage(
                topic,
                partition,
                message,
                registry,
                value,
                key,
              );
              consumedMessages.push(processed);
              if (consumedMessages.length >= maxMessages) {
                timeoutReached = true;
                resolve();
              }
            },
          })
          .catch((error) => {
            reject(error);
          });
        setTimeout(() => {
          timeoutReached = true;
          resolve();
        }, timeoutMs);
      });

      await consumePromise;

      return this.createResponse(
        `Consumed ${consumedMessages.length} messages from topics ${topicNames.join(", ")}.\nConsumed messages: ${JSON.stringify(consumedMessages, null, 2)}`,
        false,
      );
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : error instanceof KafkaJS.KafkaJSError
            ? `Kafka error (${error.code}): ${error.message}`
            : String(error);
      return this.createResponse(
        `Failed to consume messages: ${errorMessage}`,
        true,
      );
    } finally {
      if (consumer) {
        try {
          await consumer.disconnect();
        } catch (error) {
          logger.error({ error }, "Error cleaning up consumer");
        }
      }
    }
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.CONSUME_MESSAGES,
      description:
        "Consumes messages from one or more Kafka topics. Supports automatic deserialization of Schema Registry encoded messages (AVRO, JSON, PROTOBUF).",
      inputSchema: consumeKafkaMessagesArgs.shape,
    };
  }
}
