import { KafkaJS } from "@confluentinc/kafka-javascript";
import { KafkaMessage } from "@confluentinc/kafka-javascript/types/kafkajs.js";
import { SchemaRegistryClient, SerdeType } from "@confluentinc/schemaregistry";
import {
  deserializeMessage,
  getLatestSchemaIfExists,
} from "@src/confluent/schema-registry-helper.js";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  READ_ONLY,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import {
  connectionIdsWhere,
  hasKafkaBootstrap,
  isOAuth,
} from "@src/confluent/tools/connection-predicates.js";
import { resolveKafkaClusterArgs } from "@src/confluent/tools/handlers/kafka/cluster-arg-resolvers.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { logger } from "@src/logger.js";
import { ServerRuntime } from "@src/server-runtime.js";
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
  cluster_id: z
    .string()
    .optional()
    .describe(
      "The Confluent Cloud logical Kafka cluster ID (lkc-...). " +
        "Required under --oauth; under a direct connection it is ignored " +
        "(cluster fixed by configuration). Discover via list-clusters.",
    ),
  environment_id: z
    .string()
    .optional()
    .describe(
      "The Confluent Cloud environment ID (env-...) that owns the cluster. " +
        "Required alongside cluster_id under --oauth. Optional under direct.",
    ),
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
   */
  async handle(
    runtime: ServerRuntime,
    toolArguments: z.infer<typeof consumeKafkaMessagesArgs>,
    sessionId?: string,
  ): Promise<CallToolResult> {
    const parsed = consumeKafkaMessagesArgs.parse(toolArguments);
    const { topicNames, maxMessages, timeoutMs, value, key } = parsed;

    const connId = this.enabledConnectionIds(runtime)[0]!;
    const resolved = resolveKafkaClusterArgs(parsed, runtime, connId);
    const clientManager = runtime.clientManagers[connId]!;
    const conn = runtime.config.connections[connId]!;

    // Schema Registry deserialization is not yet exposed under --oauth: there
    // is no MCP tool to discover the SR cluster ID (lsrc-...). Block the path
    // here with a clear capability boundary rather than throw a discovery hint
    // that points at a tool the agent can't call. SR-under-OAuth lands in the
    // follow-up that adds list-schema-registry-clusters.
    const needsRegistry =
      value.useSchemaRegistry || (key && key.useSchemaRegistry);
    if (needsRegistry && conn.type === "oauth") {
      return this.createResponse(
        "Schema Registry deserialization is not yet supported under --oauth. " +
          "Set useSchemaRegistry: false (or omit it) to receive raw bytes, or " +
          "use a direct connection with schema_registry configured for " +
          "schema-aware deserialization.",
        true,
      );
    }

    let registry: SchemaRegistryClient | undefined;
    if (needsRegistry) {
      registry = await clientManager.getSchemaRegistrySdkClient();
    }

    const consumedMessages: ProcessedMessage[] = [];
    let timeoutReached = false;
    let consumer: KafkaJS.Consumer | undefined;

    try {
      consumer = await clientManager.buildKafkaConsumer(
        resolved.clusterId,
        resolved.envId,
        sessionId,
      );
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
      annotations: READ_ONLY,
    };
  }

  enabledConnectionIds(runtime: ServerRuntime): string[] {
    return connectionIdsWhere(
      runtime.config.connections,
      (c) => hasKafkaBootstrap(c) || isOAuth(c),
    );
  }
}
