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
import {
  confluentCloudAuthMiddleware,
  flinkAuthMiddleware,
} from "@src/confluent/middleware.js";
import type { paths } from "@src/confluent/openapi-schema";
import {
  CreateFlinkStatementArguments,
  CreateKafkaTopicsArguments,
  DeleteFlinkStatementArguments,
  DeleteKafkaTopicsArguments,
  ListConnectorsArguments,
  ListFlinkStatementsArguments,
  ListKafkaTopicsArguments,
  ProduceKafkaMessageArguments,
  ReadConnectorArguments,
  ReadFlinkStatementArguments,
} from "@src/confluent/schema.js";
import env from "@src/env.js";
import { AsyncLazy, Lazy } from "@src/lazy.js";
import createClient from "openapi-fetch";
import z from "zod";
import zodToJsonSchema from "zod-to-json-schema";

const kafkaClient = new Lazy(
  () =>
    new KafkaJS.Kafka({
      kafkaJS: {
        brokers: env.BOOTSTRAP_SERVERS?.split(",") ?? [],
        clientId: "mcp-client",
        ssl: true,
        sasl: {
          mechanism: "plain",
          username: env.KAFKA_API_KEY,
          password: env.KAFKA_API_SECRET,
        },
        logLevel: KafkaJS.logLevel.ERROR,
      },
    }),
);

const kafkaAdminClient = new AsyncLazy(
  async () => {
    console.error("Connecting Kafka Admin");
    const admin = kafkaClient.get().admin();
    await admin.connect();
    return admin;
  },
  (admin) => admin.disconnect(),
);

const kafkaProducer = new AsyncLazy(
  async () => {
    console.error("Connecting Kafka Producer");
    const producer = kafkaClient.get().producer({
      kafkaJS: {
        acks: 1,
        compression: KafkaJS.CompressionTypes.GZIP,
      },
    });
    await producer.connect();
    return producer;
  },
  (producer) => producer.disconnect(),
);

const confluentCloudFlinkRestClient = createClient<paths>({
  baseUrl: env.FLINK_REST_ENDPOINT,
});
confluentCloudFlinkRestClient.use(flinkAuthMiddleware);

const confluentCloudRestClient = createClient<paths>({
  baseUrl: env.CONFLUENT_CLOUD_REST_ENDPOINT,
});
confluentCloudRestClient.use(confluentCloudAuthMiddleware);

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
        description:
          "Return the list of topics that belong to the specified Kafka cluster.",
        inputSchema: zodToJsonSchema(ListKafkaTopicsArguments),
      },
      {
        name: "create-topics",
        description: "Create topics with the given names.",
        inputSchema: zodToJsonSchema(CreateKafkaTopicsArguments),
      },
      {
        name: "delete-topics",
        description: "Delete the topic with the given names.",
        inputSchema: zodToJsonSchema(DeleteKafkaTopicsArguments),
      },
      {
        name: "produce-message",
        description:
          "Produce records to the given topic. For saving user messages/history they should be saved to a kafka topic named claude-conversations unless otherwise specified. If the topic does not exist, it will be created via the create-topics tool.",
        inputSchema: zodToJsonSchema(ProduceKafkaMessageArguments),
      },
      {
        name: "list-flink-statements",
        description:
          "Retrieve a sorted, filtered, paginated list of all statements.",
        inputSchema: zodToJsonSchema(ListFlinkStatementsArguments),
      },
      {
        name: "create-flink-statement",
        description: "Make a request to create a statement.",
        inputSchema: zodToJsonSchema(CreateFlinkStatementArguments),
      },
      {
        name: "read-flink-statement",
        description: "Make a request to read a statement.",
        inputSchema: zodToJsonSchema(ReadFlinkStatementArguments),
      },
      {
        name: "delete-flink-statements",
        description: "Make a request to delete a statement.",
        inputSchema: zodToJsonSchema(DeleteFlinkStatementArguments),
      },
      {
        name: "list-connectors",
        description:
          'Retrieve a list of "names" of the active connectors. You can then make a read request for a specific connector by name.',
        inputSchema: zodToJsonSchema(ListConnectorsArguments),
      },
      {
        name: "read-connector",
        description: "Get information about the connector.",
        inputSchema: zodToJsonSchema(ReadConnectorArguments),
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    switch (name) {
      case "list-topics":
        return await handleListTopics(await kafkaAdminClient.get());
      case "create-topics": {
        const { topicNames } = CreateKafkaTopicsArguments.parse(args);
        return await handleCreateTopics(
          await kafkaAdminClient.get(),
          topicNames,
        );
      }
      case "delete-topics": {
        const { topicNames } = DeleteKafkaTopicsArguments.parse(args);
        return await handleDeleteTopics(
          await kafkaAdminClient.get(),
          topicNames,
        );
      }
      case "produce-message": {
        const { topicName, message } = ProduceKafkaMessageArguments.parse(args);
        return await handleProduceMessage(
          await kafkaProducer.get(),
          topicName,
          message,
        );
      }
      case "list-flink-statements": {
        const {
          organizationId,
          environmentId,
          computePoolId,
          pageSize,
          pageToken,
          labelSelector,
        } = ListFlinkStatementsArguments.parse(args);
        return await handleListFlinkStatements(
          confluentCloudFlinkRestClient,
          organizationId,
          environmentId,
          computePoolId,
          pageSize,
          pageToken,
          labelSelector,
        );
      }
      case "create-flink-statement": {
        const {
          organizationId,
          environmentId,
          statementName,
          statement,
          catalogName,
          databaseName,
          computePoolId,
        } = CreateFlinkStatementArguments.parse(args);
        return handleCreateFlinkStatement(
          confluentCloudFlinkRestClient,
          organizationId,
          environmentId,
          computePoolId,
          statement,
          statementName,
          catalogName,
          databaseName,
        );
      }
      case "read-flink-statement": {
        const { organizationId, environmentId, statementName } =
          ReadFlinkStatementArguments.parse(args);
        return handleReadFlinkStatement(
          confluentCloudFlinkRestClient,
          organizationId,
          environmentId,
          statementName,
        );
      }
      case "delete-flink-statements": {
        const { organizationId, environmentId, statementName } =
          DeleteFlinkStatementArguments.parse(args);
        return handleDeleteFlinkStatement(
          confluentCloudFlinkRestClient,
          organizationId,
          environmentId,
          statementName,
        );
      }
      case "list-connectors": {
        const { clusterId, environmentId } =
          ListConnectorsArguments.parse(args);
        return handleListConnectors(
          confluentCloudRestClient,
          environmentId,
          clusterId,
        );
      }
      case "read-connector": {
        const { environmentId, clusterId, connectorName } =
          ReadConnectorArguments.parse(args);
        return handleReadConnector(
          confluentCloudRestClient,
          environmentId,
          clusterId,
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
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("SIGQUIT", cleanup);
  process.on("SIGUSR2", cleanup);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Confluent MCP Server running on stdio");
}

async function cleanup() {
  console.error("Shutting down...");
  await kafkaAdminClient.close();
  await kafkaProducer.close();
  await server.close();
  process.exit(0);
}

main().catch((error) => {
  console.error("Error starting server:", error);
  process.exit(1);
});
