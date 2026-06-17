import {
  IHeaders,
  Message,
  RecordMetadata,
} from "@confluentinc/kafka-javascript/types/kafkajs.js";
import { SchemaRegistryClient, SerdeType } from "@confluentinc/schemaregistry";
import {
  checkSchemaNeeded,
  MessageOptions,
  SchemaCheckResult,
  serializeMessage,
} from "@src/confluent/schema-registry-helper.js";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  CREATE_UPDATE,
  ToolCategory,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import {
  disposeIfOAuth,
  formatKafkaError,
  resolveKafkaClusterArgs,
} from "@src/confluent/tools/cluster-arg-resolvers.js";
import { kafkaBootstrapOrOAuth } from "@src/confluent/tools/connection-predicates.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { z } from "zod";

const messageOptions = z.object({
  message: z
    .union([z.object({}).passthrough(), z.string(), z.number(), z.boolean()])
    .describe(
      "The payload to produce. When using schema registry, this should match the schema: an object for record schemas, or a primitive (string/number/boolean) for top-level primitive schemas such as Avro long. Without schema registry, a string is sent raw and anything else is JSON-encoded.",
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
  schemaIdLocation: z
    .enum(["prefix", "header"])
    .optional()
    .default("prefix")
    .describe(
      'Where the Schema Registry schema ID is written when useSchemaRegistry is true. "prefix" (default) embeds it as magic bytes at the front of the serialized payload — the standard Confluent wire format. "header" writes the schema GUID to the __value_schema_id / __key_schema_id Kafka record header and leaves the payload as bare serialized bytes; the matching consume-messages decode reads it back from the header. Ignored when useSchemaRegistry is false.',
    ),
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
  cluster_id: z
    .string()
    .optional()
    .describe(
      "Confluent Cloud logical Kafka cluster ID (lkc-...). Discover via list-clusters.",
    ),
  environment_id: z
    .string()
    .optional()
    .describe(
      "Confluent Cloud environment ID (env-...) that owns the cluster. Discover via list-environments.",
    ),
  partition: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Target partition number. If omitted, the producer's partitioner picks one — hashing the record key when one is set, or choosing a partition otherwise (random by default under librdkafka).",
    ),
  timestamp: z
    .union([z.string(), z.number().int().min(0)])
    .optional()
    .describe(
      'Record timestamp: a Date.parse-able date-time string (ISO 8601 recommended, e.g. "2026-05-14T17:00:00Z") or a non-negative integer ms-since-epoch number. If omitted, the record is stamped with the producer client\'s current time (CreateTime); a topic configured for LogAppendTime instead has the broker override the timestamp on append.',
    ),
  headers: z
    .record(z.string(), z.union([z.string(), z.array(z.string())]))
    .optional()
    .describe(
      "Kafka record headers as a map of name to a string or array of strings (multi-valued). Sent as raw headers, independent of schema-registry serialization of the key/value.",
    ),
});
type ProduceKafkaMessageArguments = z.infer<
  typeof produceKafkaMessageArguments
>;

/**
 * Parse a user-supplied record timestamp into epoch milliseconds, accepting any
 * Date.parse-able date-time string or a ms-since-epoch number. Returns null when
 * the value can't be parsed into a finite, non-negative instant — Date.parse maps
 * pre-1970 date-times to negative ms, which the numeric branch already rejects at
 * the Zod boundary, so the string branch must reject them too.
 */
function toEpochMs(input: string | number): number | null {
  const ms = typeof input === "number" ? input : Date.parse(input);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/**
 * Reduce a librdkafka delivery report into user-facing text plus the aggregate
 * error flag — any record with a non-zero errorCode marks the whole response an
 * error.
 */
function formatDeliveryReport(deliveryReport: RecordMetadata[]): {
  message: string;
  isError: boolean;
} {
  const message = deliveryReport
    .map((metadata) =>
      metadata.errorCode !== 0
        ? `Error producing message to [Topic: ${metadata.topicName}, Partition: ${metadata.partition}, Offset: ${metadata.offset} with ErrorCode: ${metadata.errorCode}]`
        : `Message produced successfully to [Topic: ${metadata.topicName}, Partition: ${metadata.partition}, Offset: ${metadata.offset}]`,
    )
    .join("\n");
  const isError = deliveryReport.some((metadata) => metadata.errorCode !== 0);
  return { message, isError };
}

/**
 * Build the producer message from the serialized key/value and the optional
 * record-level metadata, omitting any field the caller didn't supply.
 */
function assembleProducerMessage(parts: {
  value: Buffer | string;
  key?: Buffer | string;
  partition?: number;
  timestampMs?: number;
  headers?: IHeaders;
}): Message {
  const message: Message = { value: parts.value };
  if (parts.key !== undefined) message.key = parts.key;
  if (parts.partition !== undefined) message.partition = parts.partition;
  if (parts.timestampMs !== undefined)
    message.timestamp = String(parts.timestampMs);
  if (parts.headers !== undefined) message.headers = parts.headers;
  return message;
}

/**
 * Handler for producing messages to a Kafka topic, with support for Confluent Schema Registry serialization (AVRO, JSON, PROTOBUF) for both key and value.
 *
 * - If schema registry is enabled, `schemaType` is required and the handler checks if a schema is already registered for the topic's key/value subject.
 *   - If a schema is provided, it is registered before serialization.
 *   - If no schema is provided and one is already registered, the serializer uses the latest registered version.
 *   - If no schema is provided and none is registered, it returns an error.
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
    return this.createResponse(
      `No schema registered for subject '${result.subject}', and no schema provided to register.`,
      true,
    );
  }

  /**
   * Run the pre-serialization schema check for both sides. Returns an error
   * CallToolResult when either side needs a registered schema that isn't there
   * (and none was provided to register), or null when both sides are ready.
   */
  async checkSchemasReady(
    topicName: string,
    value: MessageOptions,
    key: MessageOptions | undefined,
    registry: SchemaRegistryClient | undefined,
  ): Promise<CallToolResult | null> {
    const valueSchemaCheck = await checkSchemaNeeded(
      topicName,
      value,
      SerdeType.VALUE,
      registry,
    );
    const valueSchemaResult = this.handleSchemaCheckResult(valueSchemaCheck);
    if (valueSchemaResult) return valueSchemaResult;

    if (key) {
      const keySchemaCheck = await checkSchemaNeeded(
        topicName,
        key,
        SerdeType.KEY,
        registry,
      );
      const keySchemaResult = this.handleSchemaCheckResult(keySchemaCheck);
      if (keySchemaResult) return keySchemaResult;
    }
    return null;
  }

  /**
   * Main handler for producing a message to a Kafka topic, including schema registry logic and serialization.
   * Handles both value and key, and returns a CallToolResult with the outcome.
   * @param clientManager - The client manager for Kafka and registry clients
   * @param toolArguments - The arguments for the tool, including topic, value, and key
   * @returns A CallToolResult describing the outcome of the produce operation
   */
  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const parsed: ProduceKafkaMessageArguments =
      produceKafkaMessageArguments.parse(toolArguments);
    const { topicName, value, key, partition, timestamp, headers } = parsed;

    const { connId, clientManager } = this.resolveConnection(
      runtime,
      toolArguments,
    );
    const resolved = resolveKafkaClusterArgs(parsed, runtime, connId);

    let timestampMs: number | undefined;
    if (timestamp !== undefined) {
      const ms = toEpochMs(timestamp);
      if (ms === null) {
        return this.createResponse(
          `Invalid timestamp '${timestamp}': expected a Date.parse-able date-time string (e.g. ISO 8601) or a non-negative integer ms-since-epoch number.`,
          true,
        );
      }
      timestampMs = ms;
    }

    const needsRegistry =
      (value && value.useSchemaRegistry) || (key && key.useSchemaRegistry);

    let registry: SchemaRegistryClient | undefined;
    if (needsRegistry) {
      registry = await clientManager.getSchemaRegistrySdkClient(resolved.envId);
    }

    const schemaIssue = await this.checkSchemasReady(
      topicName,
      value as MessageOptions,
      key as MessageOptions | undefined,
      registry,
    );
    if (schemaIssue) return schemaIssue;

    // One header map per record: seeded from the caller's headers, then handed
    // to both serialize calls so a schemaIdLocation: "header" side writes its
    // __value_schema_id / __key_schema_id into the same map the record carries.
    const recordHeaders: IHeaders = { ...headers };

    let valueToSend: Buffer | string;
    let keyToSend: Buffer | string | undefined;
    try {
      valueToSend = await serializeMessage(
        topicName,
        value as MessageOptions,
        SerdeType.VALUE,
        registry,
        recordHeaders,
      );
      if (key) {
        keyToSend = await serializeMessage(
          topicName,
          key as MessageOptions,
          SerdeType.KEY,
          registry,
          recordHeaders,
        );
      }
    } catch (err) {
      // Serialization errors come from user input (bad payload shape vs schema),
      // not the Kafka client — keep the simpler formatter here.
      return this.createResponse(
        `Failed to serialize: ${err instanceof Error ? err.message : err}`,
        true,
      );
    }

    const producer = await clientManager.getKafkaProducer(
      resolved.clusterId,
      resolved.envId,
    );
    try {
      // Send the message
      let deliveryReport: RecordMetadata[];
      try {
        deliveryReport = await producer.send({
          topic: topicName,
          messages: [
            assembleProducerMessage({
              value: valueToSend,
              key: keyToSend,
              partition,
              timestampMs,
              headers:
                Object.keys(recordHeaders).length > 0
                  ? recordHeaders
                  : undefined,
            }),
          ],
        });
      } catch (err) {
        return this.createResponse(
          `Failed to produce message: ${formatKafkaError(err)}`,
          true,
        );
      }
      const { message, isError } = formatDeliveryReport(deliveryReport);
      return this.createResponse(message, isError);
    } finally {
      await disposeIfOAuth(runtime, connId, producer);
    }
  }

  /**
   * Returns the tool configuration including name, description, and input schema.
   * @returns The tool configuration
   */
  getToolConfig(): ToolConfig {
    return {
      name: ToolName.PRODUCE_MESSAGE,
      description: `Produce records to a Kafka topic. Supports Confluent Schema Registry serialization (AVRO, JSON, PROTOBUF) for both key and value, plus optional record-level partition, timestamp, and headers for faithful reproduction of records across clusters.\n\nBefore producing, check if the topic has a registered schema for <topicName>-value and <topicName>-key. If a schema exists, set useSchemaRegistry to true and specify the appropriate schemaType. If the topic does not exist, it can be created via the ${ToolName.CREATE_TOPICS} tool.`,
      inputSchema: produceKafkaMessageArguments.shape,
      annotations: CREATE_UPDATE,
    };
  }

  readonly category = ToolCategory.Kafka;
  readonly predicate = kafkaBootstrapOrOAuth;
}
