import { KafkaJS } from "@confluentinc/kafka-javascript";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { DefaultClientManager } from "@src/confluent/client-manager.js";
import { ToolHandler } from "@src/confluent/tools/base-tools.js";
import { ToolFactory } from "@src/confluent/tools/tool-factory.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import env from "@src/env.js";

const kafkaClientConfig: KafkaJS.CommonConstructorConfig = {
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
};

const clientManager = new DefaultClientManager(
  kafkaClientConfig,
  env.CONFLUENT_CLOUD_REST_ENDPOINT,
  env.FLINK_REST_ENDPOINT,
  env.SCHEMA_REGISTRY_ENDPOINT,
);

const toolHandlers = new Map<ToolName, ToolHandler>();
const enabledTools = new Set<ToolName>([
  ToolName.LIST_TOPICS,
  ToolName.LIST_TOPICS_WITH_A_SPECIFIED_TAG,
  ToolName.CREATE_TOPICS,
  ToolName.DELETE_TOPICS,
  ToolName.PRODUCE_MESSAGE,
  ToolName.LIST_FLINK_STATEMENTS,
  ToolName.READ_FLINK_STATEMENT,
  ToolName.CREATE_FLINK_STATEMENT,
  ToolName.DELETE_FLINK_STATEMENTS,
  ToolName.LIST_CONNECTORS,
  ToolName.READ_CONNECTOR,
  ToolName.CREATE_CONNECTOR,
]);

enabledTools.forEach((toolName) => {
  toolHandlers.set(toolName, ToolFactory.createToolHandler(toolName));
});

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
    tools: ToolFactory.getToolConfigs(),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const toolHandler = toolHandlers.get(name as ToolName);
  console.error(`${name}`);
  if (!toolHandler) {
    throw new Error(`Tool handler not found for: ${name}`);
  }
  return await toolHandler.handle(clientManager, args);
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
  await clientManager.disconnect();
  await server.close();
  process.exit(0);
}

main().catch((error) => {
  console.error("Error starting server:", error);
  process.exit(1);
});
