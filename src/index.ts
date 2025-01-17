import { KafkaJS } from "@confluentinc/kafka-javascript";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  handleCreateFlinkStatement,
  handleCreateTopics,
  handleDeleteFlinkStatement,
  handleDeleteTopics,
  handleListConnectors,
  handleListFlinkStatements,
  handleListTopics,
  handleProduceMessage,
  handleReadConnector,
  handleReadFlinkStatement,
} from "@src/confluent/handlers.js";
import { authMiddleware } from "@src/confluent/middleware.js";
import type { paths } from "@src/confluent/openapi-schema";
import {
  CreateFlinkStatementArgumentsSchema,
  CreateFlinkStatementInputSchema,
  CreateTopicsArgumentsSchema,
  CreateTopicsInputSchema,
  DeleteFlinkStatementArgumentsSchema,
  DeleteFlinkStatementsInputSchema,
  DeleteTopicsArgumentsSchema,
  DeleteTopicsInputSchema,
  ListConnectorsInputSchema,
  ListFlinkStatementsArgumentsSchema,
  ListFlinkStatementsInputSchema,
  ListTopicsInputSchema,
  ProduceMessageArgumentsSchema,
  ProduceMessageInputSchema,
  ReadConnectorArgumentsSchema,
  ReadConnectorInputSchema,
  ReadFlinkStatementArgumentsSchema,
  ReadFlinkStatementInputSchema,
} from "@src/confluent/schema.js";
import env from "@src/env.js";
import createClient from "openapi-fetch";
import z from "zod";

const kafkaClient = new KafkaJS.Kafka({
  kafkaJS: {
    brokers: env.BOOTSTRAP_SERVERS.split(","),
    clientId: "mcp-client",
    ssl: true,
    sasl: {
      mechanism: "plain",
      username: env.KAFKA_API_KEY,
      password: env.KAFKA_API_SECRET,
    },
    logLevel: KafkaJS.logLevel.ERROR,
  },
});

const kafkaAdminClient = kafkaClient.admin();
const kafkaProducer = kafkaClient.producer({
  kafkaJS: {
    acks: 1,
    compression: KafkaJS.CompressionTypes.GZIP,
  },
});
const confluentCloudFlinkRestClient = createClient<paths>({
  baseUrl: env.FLINK_REST_ENDPOINT,
});
confluentCloudFlinkRestClient.use(authMiddleware);

const confluentCloudRestClient = createClient<paths>({
  baseUrl: env.CONFLUENT_CLOUD_REST_ENDPOINT,
});
confluentCloudRestClient.use(authMiddleware);

const server = new Server(
  {
    name: "confluent",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "list-topics",
        description: "List Kafka topics",
        inputSchema: ListTopicsInputSchema,
      },
      {
        name: "create-topics",
        description: "Create Kafka topics",
        inputSchema: CreateTopicsInputSchema,
      },
      {
        name: "delete-topics",
        description: "Delete Kafka topics",
        inputSchema: DeleteTopicsInputSchema,
      },
      {
        name: "produce-message",
        description:
          "Produces all user messages to a Kafka topic named claude-conversations. If the topic does not exist, it will be created via the create-topics tool.",
        inputSchema: ProduceMessageInputSchema,
      },
      {
        name: "list-flink-statements",
        description: "List Flink SQL statements",
        inputSchema: ListFlinkStatementsInputSchema,
      },
      {
        name: "create-flink-statement",
        description: "Create Flink SQL statement",
        inputSchema: CreateFlinkStatementInputSchema,
      },
      {
        name: "read-flink-statement",
        description: "Read Flink SQL statement",
        inputSchema: ReadFlinkStatementInputSchema,
      },
      {
        name: "delete-flink-statements",
        description: "Delete Flink SQL statement",
        inputSchema: DeleteFlinkStatementsInputSchema,
      },
      {
        name: "list-connectors",
        description: "List Active Connectors",
        inputSchema: ListConnectorsInputSchema,
      },
      {
        name: "read-connector",
        description: "Get Connector Details",
        inputSchema: ReadConnectorInputSchema,
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    switch (name) {
      case "list-topics":
        return await handleListTopics(kafkaAdminClient);
      case "create-topics": {
        const { topicNames } = CreateTopicsArgumentsSchema.parse(args);
        return await handleCreateTopics(kafkaAdminClient, topicNames);
      }
      case "delete-topics": {
        const { topicNames } = DeleteTopicsArgumentsSchema.parse(args);
        return await handleDeleteTopics(kafkaAdminClient, topicNames);
      }
      case "produce-message": {
        const { topicName, message } =
          ProduceMessageArgumentsSchema.parse(args);
        return await handleProduceMessage(kafkaProducer, topicName, message);
      }
      case "list-flink-statements": {
        const { computePoolId, pageSize, pageToken, labelSelector } =
          ListFlinkStatementsArgumentsSchema.parse(args);
        return await handleListFlinkStatements(
          confluentCloudFlinkRestClient,
          env.FLINK_ORG_ID,
          env.FLINK_ENV_ID,
          computePoolId,
          pageSize,
          pageToken,
          labelSelector,
        );
      }
      case "create-flink-statement": {
        const { statementName, statement } =
          CreateFlinkStatementArgumentsSchema.parse(args);
        return handleCreateFlinkStatement(
          confluentCloudFlinkRestClient,
          env.FLINK_ORG_ID,
          env.FLINK_ENV_ID,
          env.FLINK_COMPUTE_POOL_ID,
          statement,
          statementName,
          env.FLINK_ENV_NAME,
          env.FLINK_DATABASE_NAME,
        );
      }
      case "read-flink-statement": {
        const { statementName } = ReadFlinkStatementArgumentsSchema.parse(args);
        return handleReadFlinkStatement(
          confluentCloudFlinkRestClient,
          env.FLINK_ORG_ID,
          env.FLINK_ENV_ID,
          statementName,
        );
      }
      case "delete-flink-statements": {
        const { statementName } =
          DeleteFlinkStatementArgumentsSchema.parse(args);
        return handleDeleteFlinkStatement(
          confluentCloudFlinkRestClient,
          env.FLINK_ORG_ID,
          env.FLINK_ENV_ID,
          statementName,
        );
      }
      case "list-connectors": {
        return handleListConnectors(
          confluentCloudRestClient,
          env.KAFKA_ENV_ID,
          env.KAFKA_CLUSTER_ID,
        );
      }
      case "read-connector": {
        const { connectorName } = ReadConnectorArgumentsSchema.parse(args);
        return handleReadConnector(
          confluentCloudRestClient,
          env.KAFKA_ENV_ID,
          env.KAFKA_CLUSTER_ID,
          connectorName,
        );
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(
        `Invalid arguments: ${error.errors.map((e) => e.message).join(", ")}`,
      );
    }
    throw error;
  }
});

async function main() {
  try {
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);

    await kafkaAdminClient.connect();
    await kafkaProducer.connect();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Confluent MCP Server running on stdio");
  } catch (error) {
    console.error("Error starting server:", error);
    await cleanup();
    process.exit(1);
  }
}

async function cleanup() {
  console.error("Shutting down...");
  await kafkaAdminClient.disconnect();
  await kafkaProducer.disconnect();
  process.exit(0);
}

main();
