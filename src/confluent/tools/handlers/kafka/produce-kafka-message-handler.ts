import { RecordMetadata } from "@confluentinc/kafka-javascript/types/kafkajs.js";
import { ClientManager } from "@src/confluent/client-manager.js";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import env from "@src/env.js";
import { z } from "zod";
// Import serializers and client from @confluentinc/schemaregistry
import {
  AvroSerializer,
  JsonSerializer,
  ProtobufSerializer,
  SchemaRegistryClient,
  SerdeType,
  Serializer,
} from "@confluentinc/schemaregistry";

const messageOptions = z.object({
  message: z
    .any()
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
  serializerType: z
    .enum(["AVRO", "JSON", "PROTOBUF"])
    .optional()
    .describe(
      "Serialization type to use. If omitted, sends as raw string/JSON.",
    ),
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
  useLatestVersion: z
    .boolean()
    .optional()
    .describe(
      "Whether to use the latest version of the schema for serialization. Default: true.",
    ),
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

function getSerializer(
  serializerType: MessageOptions["serializerType"],
  registry: SchemaRegistryClient,
  serdeType: SerdeType,
  useLatestVersion: boolean,
): Serializer {
  const serializers = {
    AVRO: () => new AvroSerializer(registry, serdeType, { useLatestVersion }),
    JSON: () => new JsonSerializer(registry, serdeType, { useLatestVersion }),
    PROTOBUF: () =>
      new ProtobufSerializer(registry, serdeType, { useLatestVersion }),
  };

  if (!serializerType || !(serializerType in serializers)) {
    throw new Error(`Unknown serializerType: ${serializerType}`);
  }

  return serializers[serializerType]();
}

async function serializeMessage(
  topicName: string,
  options: MessageOptions,
  serdeType: SerdeType,
  registry: SchemaRegistryClient | undefined,
): Promise<Buffer | string> {
  if (!options.useSchemaRegistry) {
    // No schema registry, just stringify if needed
    return typeof options.message === "string"
      ? options.message
      : JSON.stringify(options.message);
  }
  if (!options.serializerType) {
    throw new Error(
      "serializerType is required when useSchemaRegistry is true",
    );
  }
  if (!registry) {
    throw new Error("Schema Registry client is required for serialization");
  }
  const subject = options.subject;
  if (options.schema && subject) {
    await registry.register(
      subject,
      { schema: options.schema, schemaType: options.serializerType },
      options.normalize,
    );
  }
  const serializer = getSerializer(
    options.serializerType,
    registry,
    serdeType,
    options.useLatestVersion ?? true,
  );
  return serializer.serialize(topicName, options.message);
}

export class ProduceKafkaMessageHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const { topicName, value, key }: ProduceKafkaMessageArguments =
      produceKafkaMessageArguments.parse(toolArguments);

    // Only create registry if needed
    const needsRegistry =
      value.useSchemaRegistry || (key && key.useSchemaRegistry);
    let registry: SchemaRegistryClient | undefined = undefined;
    if (needsRegistry) {
      registry = new SchemaRegistryClient({
        baseURLs: [String(env.SCHEMA_REGISTRY_ENDPOINT)],
        basicAuthCredentials: {
          credentialsSource: "USER_INFO",
          userInfo: `${String(env.SCHEMA_REGISTRY_API_KEY)}:${String(env.SCHEMA_REGISTRY_API_SECRET)}`,
        },
      });
    }

    let valueToSend: Buffer | string;
    let keyToSend: Buffer | string | undefined;
    try {
      valueToSend = await serializeMessage(
        topicName,
        value,
        SerdeType.VALUE,
        registry,
      );
      if (key) {
        keyToSend = await serializeMessage(
          topicName,
          key,
          SerdeType.KEY,
          registry,
        );
      }
    } catch (err) {
      return this.createResponse(`Failed to serialize: ${err}`, true);
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
      return this.createResponse(`Failed to produce message: ${err}`, true);
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
      description: `Produce records to a Kafka topic. Supports Confluent Schema Registry serialization (AVRO, JSON, PROTOBUF) for both key and value.\n\nBefore producing, check if the topic has a registered schema for <topicName>-value and <topicName>-key. If a schema exists, set useSchemaRegistry to true and specify the appropriate serializerType. For saving user messages/history, use the kafka topic named claude-conversations unless otherwise specified. If the topic does not exist, it can be created via the ${ToolName.CREATE_TOPICS} tool.`,
      inputSchema: produceKafkaMessageArguments.shape,
    };
  }
}
