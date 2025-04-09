#!/usr/bin/env node

import { KafkaJS } from "@confluentinc/kafka-javascript";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseCliArgs } from "@src/cli.js";
import { DefaultClientManager } from "@src/confluent/client-manager.js";
import { ToolHandler } from "@src/confluent/tools/base-tools.js";
import { ToolFactory } from "@src/confluent/tools/tool-factory.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { initEnv } from "@src/env.js";

// Parse command line arguments and load environment variables if --env-file is specified
parseCliArgs();

async function main() {
  try {
    // Initialize environment after CLI args are processed
    const env = await initEnv();

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
      env.KAFKA_REST_ENDPOINT,
    );

    const toolHandlers = new Map<ToolName, ToolHandler>();
    // TODO: Should we have the enabled tools come from configuration?
    const enabledTools = new Set<ToolName>(Object.values(ToolName));

    enabledTools.forEach((toolName) => {
      toolHandlers.set(toolName, ToolFactory.createToolHandler(toolName));
    });

    const server = new McpServer({
      name: "confluent",
      version: process.env.npm_package_version ?? "dev",
    });

    toolHandlers.forEach((handler, name) => {
      const config = handler.getToolConfig();

      server.tool(
        name as string,
        config.description,
        config.inputSchema,
        async (args) => {
          return await handler.handle(clientManager, args);
        },
      );
    });

    // Set up cleanup handlers
    const performCleanup = async () => {
      console.error("Shutting down...");
      await clientManager.disconnect();
      await server.close();
      process.exit(0);
    };

    process.on("SIGINT", performCleanup);
    process.on("SIGTERM", performCleanup);
    process.on("SIGQUIT", performCleanup);
    process.on("SIGUSR2", performCleanup);

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Confluent MCP Server running on stdio");
  } catch (error) {
    console.error("Error starting server:", error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Error starting server:", error);
  process.exit(1);
});
