#!/usr/bin/env node

import { KafkaJS } from "@confluentinc/kafka-javascript";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseCliArgs } from "@src/cli.js";
import { DefaultClientManager } from "@src/confluent/client-manager.js";
import { ToolHandler } from "@src/confluent/tools/base-tools.js";
import { ToolFactory } from "@src/confluent/tools/tool-factory.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { initEnv } from "@src/env.js";
import { kafkaLogger, logger } from "@src/logger.js";
import { TransportManager } from "@src/mcp/transports/index.js";

// Parse command line arguments and load environment variables if --env-file is specified
const cliOptions = parseCliArgs();

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
        logger: kafkaLogger,
      },
    };

    const requiredEnvVars = {
      CONFLUENT_CLOUD_REST_ENDPOINT: env.CONFLUENT_CLOUD_REST_ENDPOINT,
      CONFLUENT_CLOUD_API_KEY: env.CONFLUENT_CLOUD_API_KEY,
      CONFLUENT_CLOUD_API_SECRET: env.CONFLUENT_CLOUD_API_SECRET,
      FLINK_REST_ENDPOINT: env.FLINK_REST_ENDPOINT,
      FLINK_API_KEY: env.FLINK_API_KEY,
      FLINK_API_SECRET: env.FLINK_API_SECRET,
      SCHEMA_REGISTRY_ENDPOINT: env.SCHEMA_REGISTRY_ENDPOINT,
      SCHEMA_REGISTRY_API_KEY: env.SCHEMA_REGISTRY_API_KEY,
      SCHEMA_REGISTRY_API_SECRET: env.SCHEMA_REGISTRY_API_SECRET,
      KAFKA_REST_ENDPOINT: env.KAFKA_REST_ENDPOINT,
      KAFKA_API_KEY: env.KAFKA_API_KEY,
      KAFKA_API_SECRET: env.KAFKA_API_SECRET,
    };

    const missingVars = Object.entries(requiredEnvVars)
      .filter(([, value]) => !value)
      .map(([key]) => key);

    if (missingVars.length > 0) {
      throw new Error(
        `Missing required environment variables: ${missingVars.join(", ")}`,
      );
    }

    // After the check, we know all values are defined
    const envVars = requiredEnvVars as Record<
      keyof typeof requiredEnvVars,
      string
    >;

    const clientManager = new DefaultClientManager({
      kafka: kafkaClientConfig,
      endpoints: {
        cloud: envVars.CONFLUENT_CLOUD_REST_ENDPOINT,
        flink: envVars.FLINK_REST_ENDPOINT,
        schemaRegistry: envVars.SCHEMA_REGISTRY_ENDPOINT,
        kafka: envVars.KAFKA_REST_ENDPOINT,
      },
      auth: {
        cloud: {
          apiKey: envVars.CONFLUENT_CLOUD_API_KEY,
          apiSecret: envVars.CONFLUENT_CLOUD_API_SECRET,
        },
        flink: {
          apiKey: envVars.FLINK_API_KEY,
          apiSecret: envVars.FLINK_API_SECRET,
        },
        schemaRegistry: {
          apiKey: envVars.SCHEMA_REGISTRY_API_KEY,
          apiSecret: envVars.SCHEMA_REGISTRY_API_SECRET,
        },
        kafka: {
          apiKey: envVars.KAFKA_API_KEY,
          apiSecret: envVars.KAFKA_API_SECRET,
        },
      },
    });

    const toolHandlers = new Map<ToolName, ToolHandler>();
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
        async (args, context) => {
          const sessionId = context?.sessionId;
          return await handler.handle(clientManager, args, sessionId);
        },
      );
    });

    const transportManager = new TransportManager(server);

    // Start all transports with a single call
    await transportManager.start(
      cliOptions.transports,
      env.HTTP_PORT ? Number(env.HTTP_PORT) : undefined,
      env.HTTP_HOST,
    );

    // Set up cleanup handlers
    const performCleanup = async () => {
      logger.info("Shutting down...");
      await clientManager.disconnect();
      await transportManager.stop();
      await server.close();
      process.exit(0);
    };

    process.on("SIGINT", performCleanup);
    process.on("SIGTERM", performCleanup);
    process.on("SIGQUIT", performCleanup);
    process.on("SIGUSR2", performCleanup);
  } catch (error) {
    logger.error({ error }, "Error starting server");
    process.exit(1);
  }
}

main().catch((error) => {
  logger.error({ error }, "Error starting server");
  process.exit(1);
});
