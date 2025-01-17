import { z } from "zod";

export const ListKafkaTopicsArguments = z.object({
  // No arguments
});

export const CreateKafkaTopicsArguments = z.object({
  topicNames: z
    .array(z.string().describe("Names of kafka topics to create"))
    .nonempty(),
});

export const DeleteKafkaTopicsArguments = z.object({
  topicNames: z
    .array(z.string().describe("Names of kafka topics to delete"))
    .nonempty(),
});

export const ProduceKafkaMessageArguments = z.object({
  topicName: z
    .string()
    .nonempty()
    .describe("Name of the kafka topic to produce the message to"),
  message: z
    .string()
    .nonempty()
    .describe("The content of the message to produce"),
});

const FlinkParamsSchema = z.object({
  organizationId: z
    .string()
    .optional()
    .describe("The unique identifier for the organization."),
  environmentId: z
    .string()
    .optional()
    .describe("The unique identifier for the environment."),
});

export const ListFlinkStatementsArguments = FlinkParamsSchema.extend({
  computePoolId: z
    .string()
    .optional()
    .describe("Filter the results by exact match for compute_pool."),
  pageSize: z
    .number()
    .int()
    .nonnegative()
    .max(100)
    .default(10)
    .describe("A pagination size for collection requests."),
  pageToken: z
    .string()
    .max(255)
    .optional()
    .describe("An opaque pagination token for collection requests."),
  labelSelector: z
    .string()
    .optional()
    .describe("A comma-separated label selector to filter the statements."),
});

export const CreateFlinkStatementArguments = FlinkParamsSchema.extend({
  computePoolId: z
    .string()
    .optional()
    .describe("Filter the results by exact match for compute_pool."),
  statement: z
    .string()
    .nonempty()
    .max(131072)
    .describe(
      "The raw Flink SQL text statement. Create table statements may not be necessary as topics in confluent cloud will be detected as created schemas. Make sure to show and describe tables before creating new ones.",
    ),
  statementName: z
    .string()
    .regex(
      new RegExp(
        "[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*",
      ),
    )
    .nonempty()
    .max(100)
    .describe(
      "The user provided name of the resource, unique within this environment.",
    ),
  catalogName: z
    .string()
    .nonempty()
    .describe(
      "The catalog name to be used for the statement. Typically the confluent environment name.",
    ),
  databaseName: z
    .string()
    .nonempty()
    .describe(
      "The database name to be used for the statement. Typically the Kafka cluster name.",
    ),
});

export const ReadFlinkStatementArguments = FlinkParamsSchema.extend({
  statementName: z
    .string()
    .nonempty()
    .describe("The unique identifier for the statement."),
});

export const DeleteFlinkStatementArguments = FlinkParamsSchema.extend({
  statementName: z
    .string()
    .nonempty()
    .describe("The unique identifier for the statement."),
});
const ConnectorParamsSchema = z.object({
  environmentId: z
    .string()
    .optional()
    .describe(
      "The unique identifier for the environment this resource belongs to.",
    ),
  clusterId: z
    .string()
    .optional()
    .describe("The unique identifier for the Kafka cluster."),
});
export const ListConnectorsArguments = ConnectorParamsSchema.extend({});

export const ReadConnectorArguments = ConnectorParamsSchema.extend({
  connectorName: z
    .string()
    .nonempty()
    .describe("The unique name of the connector."),
});

// Add type exports for TypeScript
export type ListKafkaTopicsArguments = z.infer<typeof ListKafkaTopicsArguments>;
export type CreateKafkaTopicsArguments = z.infer<
  typeof CreateKafkaTopicsArguments
>;
export type DeleteKafkaTopicsArguments = z.infer<
  typeof DeleteKafkaTopicsArguments
>;
export type ProduceKafkaMessageArguments = z.infer<
  typeof ProduceKafkaMessageArguments
>;
export type ListFlinkStatementsArguments = z.infer<
  typeof ListFlinkStatementsArguments
>;
export type CreateFlinkStatementArguments = z.infer<
  typeof CreateFlinkStatementArguments
>;
export type ReadFlinkStatementArguments = z.infer<
  typeof ReadFlinkStatementArguments
>;
export type DeleteFlinkStatementArguments = z.infer<
  typeof DeleteFlinkStatementArguments
>;
export type ListConnectorsArguments = z.infer<typeof ListConnectorsArguments>;
export type ReadConnectorArguments = z.infer<typeof ReadConnectorArguments>;
