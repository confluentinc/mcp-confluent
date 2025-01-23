import { z } from "zod";

export const ListTopicsArgumentsSchema = z.object({
  // No arguments
});

export const CreateTopicsArgumentsSchema = z.object({
  topicNames: z.array(z.string()).nonempty(),
});

export const DeleteTopicsArgumentsSchema = z.object({
  topicNames: z.array(z.string()).nonempty(),
});

export const ProduceMessageArgumentsSchema = z.object({
  topicName: z.string().nonempty(),
  message: z.string().nonempty(),
});

export const ListFlinkStatementsArgumentsSchema = z.object({
  computePoolId: z.string().optional(),
  pageSize: z.number().int().nonnegative().max(100).default(10),
  pageToken: z.string().max(255).optional(),
  labelSelector: z.string().optional(),
});

export const CreateFlinkStatementArgumentsSchema = z.object({
  statement: z
    .string()
    .regex(
      new RegExp(
        "[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*",
      ),
    )
    .nonempty()
    .max(131072),
  statementName: z.string().nonempty().max(255),
});

export const ReadFlinkStatementArgumentsSchema = z.object({
  statementName: z.string().nonempty().max(255),
});

export const DeleteFlinkStatementArgumentsSchema = z.object({
  statementName: z.string().nonempty().max(255),
});

export const ListConnectorsArgumentsSchema = z.object({
  // No arguments
});

export const ReadConnectorArgumentsSchema = z.object({
  connectorName: z.string().nonempty(),
});

export const GetConnectorConfigArgumentsSchema = z.object({
  pluginName: z.string().nonempty(),
});

export const ListTopicsInputSchema = {
  type: "object",
  properties: {},
  required: [],
};

export const CreateTopicsInputSchema = {
  type: "object",
  properties: {
    topicNames: {
      type: "array",
      items: {
        type: "string",
      },
    },
  },
  required: ["topicNames"],
};

export const DeleteTopicsInputSchema = {
  type: "object",
  properties: {
    topicNames: {
      type: "array",
      items: {
        type: "string",
      },
    },
  },
  required: ["topicNames"],
};

export const ProduceMessageInputSchema = {
  type: "object",
  properties: {
    topicName: {
      type: "string",
      description: "The Kafka topic to produce the message to",
    },
    message: {
      type: "string",
      description: "The message to produce",
    },
  },
  required: ["message"],
};

export const ListFlinkStatementsInputSchema = {
  type: "object",
  properties: {
    computePoolId: {
      type: "string",
      description: "The compute pool ID to list Flink SQL statements for",
    },
    pageSize: {
      type: "integer",
      description:
        "The number of Flink SQL statements to return. <= 100. Defaults to 10",
    },
    pageToken: {
      type: "string",
      description: "An opaque pagination token for collection requests.",
    },
    labelSelector: {
      type: "string",
      description: "A comma-separated label selector to filter the statements.",
    },
  },
  required: [],
};

export const CreateFlinkStatementInputSchema = {
  type: "object",
  properties: {
    statement: {
      type: "string",
      description: "The Flink SQL statement to create",
    },
    statementName: {
      type: "string",
      description: "The name of the Flink SQL statement",
    },
  },
  required: ["statement", "statementName"],
};

export const ReadFlinkStatementInputSchema = {
  type: "object",
  properties: {
    statementName: {
      type: "string",
      description: "The name of the Flink SQL statement to read values from",
    },
  },
  required: ["statementName"],
};

export const DeleteFlinkStatementsInputSchema = {
  type: "object",
  properties: {
    statementName: {
      type: "string",
      description: "The name of the Flink SQL statement to delete.",
    },
  },
  required: ["statementName"],
};

export const ListConnectorsInputSchema = {
  type: "object",
  properties: {},
  required: [],
};

export const ReadConnectorInputSchema = {
  type: "object",
  properties: {
    connectorName: {
      type: "string",
      description: "The unique name of the connector.",
    },
  },
  required: ["connectorName"],
};

export const GetConnectorConfigInputSchema = {
  type: "object",
  properties: {
    pluginName: {
      type: "string",
      description: "The unique name of the connector plugin.",
    },
  },
  required: ["pluginName"],
};

// Add type exports for TypeScript
export type ListTopicsArguments = z.infer<typeof ListTopicsArgumentsSchema>;
export type CreateTopicsArguments = z.infer<typeof CreateTopicsArgumentsSchema>;
export type DeleteTopicsArguments = z.infer<typeof DeleteTopicsArgumentsSchema>;
export type ProduceMessageArguments = z.infer<
  typeof ProduceMessageArgumentsSchema
>;
export type ListFlinkStatementsArguments = z.infer<
  typeof ListFlinkStatementsArgumentsSchema
>;
export type CreateFlinkStatementArguments = z.infer<
  typeof CreateFlinkStatementArgumentsSchema
>;
export type ReadFlinkStatementArguments = z.infer<
  typeof ReadFlinkStatementArgumentsSchema
>;
export type DeleteFlinkStatementArguments = z.infer<
  typeof DeleteFlinkStatementArgumentsSchema
>;
export type ListConnectorsArguments = z.infer<
  typeof ListConnectorsArgumentsSchema
>;
export type ReadConnectorArguments = z.infer<
  typeof ReadConnectorArgumentsSchema
>;
export type GetConnectorConfigArguments = z.infer<
  typeof GetConnectorConfigArgumentsSchema
>;
