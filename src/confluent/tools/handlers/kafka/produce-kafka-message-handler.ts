import { RecordMetadata } from "@confluentinc/kafka-javascript/types/kafkajs.js";
import { ClientManager } from "@src/confluent/client-manager.js";
import { CallToolResult, ToolInput } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

const produceKafkaMessageArguments = z.object({
  topicName: z
    .string()
    .nonempty()
    .describe("Name of the kafka topic to produce the message to"),
  message: z
    .string()
    .nonempty()
    .describe("The content of the message to produce"),
});
export class ProduceKafkaMessageHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const { topicName, message } =
      produceKafkaMessageArguments.parse(toolArguments);
    const deliveryReport: RecordMetadata[] = await (
      await clientManager.getProducer()
    ).send({ topic: topicName, messages: [{ value: message }] });
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
      description: `Produce records to a Kafka topic. For saving user messages/history they should be saved to a kafka topic named claude-conversations unless otherwise specified. If the topic does not exist, it will be created via the ${ToolName.CREATE_TOPICS} tool.`,
      inputSchema: zodToJsonSchema(produceKafkaMessageArguments) as ToolInput,
    };
  }
}
