import { KafkaJS } from "@confluentinc/kafka-javascript";
import { KafkaMessage } from "@confluentinc/kafka-javascript/types/kafkajs.js";
import { ClientManager } from "@src/confluent/client-manager.js";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { z } from "zod";

// Input schema for the consume-kafka-messages tool
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
});

export class ConsumeKafkaMessagesHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: z.infer<typeof consumeKafkaMessagesArgs>,
  ): Promise<CallToolResult> {
    console.error("Starting consume-kafka-messages handler");
    const { topicNames, maxMessages, timeoutMs } =
      consumeKafkaMessagesArgs.parse(toolArguments);
    console.error(`Consuming from topics: ${topicNames.join(", ")}`);
    console.error(`Max messages: ${maxMessages}, Timeout: ${timeoutMs}ms`);

    const consumedMessages: KafkaMessage[] = [];
    let timeoutReached = false;
    let consumer: KafkaJS.Consumer | undefined;

    try {
      console.error("Getting consumer from client manager");
      consumer = await clientManager.getConsumer();

      await consumer.connect();

      // Subscribe to topics
      await consumer.subscribe({ topics: topicNames });
      console.error(`Subscribed to topics: ${topicNames.join(", ")}`);

      const consumePromise = new Promise<void>((resolve, reject) => {
        if (!consumer) {
          reject(new Error("Consumer was unexpectedly undefined"));
          return;
        }

        console.error("Starting consumer run");
        consumer
          .run({
            eachMessage: async ({ topic, partition, message }) => {
              if (timeoutReached) {
                console.error("Timeout reached, skipping message");
                return;
              }
              console.error(
                `Received message from topic ${topic} partition ${partition} at offset ${message.offset}`,
              );
              consumedMessages.push(message);
              if (consumedMessages.length >= maxMessages) {
                console.error(
                  `Reached max messages (${maxMessages}), resolving`,
                );
                timeoutReached = true;
                resolve();
              }
            },
          })
          .catch((error) => {
            console.error("Error in consumer.run():", error);
            reject(error);
          });

        // Set timeout
        setTimeout(() => {
          console.error("Timeout reached");
          timeoutReached = true;
          resolve();
        }, timeoutMs);
      });

      // Wait for either max messages or timeout
      console.error("Waiting for messages or timeout");
      await consumePromise;

      console.error(`Formatting ${consumedMessages.length} messages`);
      const formattedMessages = consumedMessages.map((msg) => ({
        key: msg.key?.toString(),
        value: msg.value?.toString(),
        timestamp: msg.timestamp,
        offset: msg.offset,
        headers: msg.headers,
      }));

      console.error("Returning response");
      return this.createResponse(
        `Consumed ${formattedMessages.length} messages from topics ${topicNames.join(", ")}.\nConsumed messages: ${JSON.stringify(formattedMessages)}`,
        false,
      );
    } catch (error: unknown) {
      console.error("Error in consume process:", error);
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
          console.error("Error cleaning up consumer:", error);
        }
      }
    }
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.CONSUME_MESSAGES,
      description: "Consumes messages from one or more Kafka topics.",
      inputSchema: consumeKafkaMessagesArgs.shape,
    };
  }
}
