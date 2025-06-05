#!/usr/bin/env node

import { GlobalConfig } from "@confluentinc/kafka-javascript";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  getFilteredToolNames,
  getPackageVersion,
  parseCliArgs,
} from "@src/cli.js";
import { DefaultClientManager } from "@src/confluent/client-manager.js";
import { ToolHandler } from "@src/confluent/tools/base-tools.js";
import { ToolFactory } from "@src/confluent/tools/tool-factory.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { EnvVar } from "@src/env-schema.js";
import { initEnv } from "@src/env.js";
import { logger, setLogLevel } from "@src/logger.js";
import { TransportManager } from "@src/mcp/transports/index.js";
import { PromptFactory } from "@src/confluent/prompts/prompt-factory.js";

// Parse command line arguments and load environment variables if --env-file is specified
const cliOptions = parseCliArgs();

async function main() {
  try {
    // Initialize environment after CLI args are processed
    const env = await initEnv();
    setLogLevel(env.LOG_LEVEL);

    // Merge environment variables with kafka config from CLI
    // some additional configurations could be set in the client manager
    // like separating groupIds by sessionId
    const kafkaClientConfig: GlobalConfig = {
      // Base configuration from environment variables
      "bootstrap.servers": env.BOOTSTRAP_SERVERS!,
      "client.id": "mcp-confluent",
      ...(env.KAFKA_API_KEY && env.KAFKA_API_SECRET
        ? {
            "security.protocol": "sasl_ssl",
            "sasl.mechanisms": "PLAIN",
            "sasl.username": env.KAFKA_API_KEY!,
            "sasl.password": env.KAFKA_API_SECRET!,
          }
        : {}),
      // Merge any additional properties from the kafka config file
      ...cliOptions.kafkaConfig,
    };

    const clientManager = new DefaultClientManager({
      kafka: kafkaClientConfig,
      endpoints: {
        cloud: env.CONFLUENT_CLOUD_REST_ENDPOINT,
        flink: env.FLINK_REST_ENDPOINT,
        schemaRegistry: env.SCHEMA_REGISTRY_ENDPOINT,
        kafka: env.KAFKA_REST_ENDPOINT,
        telemetry: env.CONFLUENT_CLOUD_TELEMETRY_ENDPOINT,
      },
      auth: {
        cloud: {
          apiKey: env.CONFLUENT_CLOUD_API_KEY!,
          apiSecret: env.CONFLUENT_CLOUD_API_SECRET!,
        },
        tableflow: {
          apiKey: env.TABLEFLOW_API_KEY!,
          apiSecret: env.TABLEFLOW_API_SECRET!,
        },
        flink: {
          apiKey: env.FLINK_API_KEY!,
          apiSecret: env.FLINK_API_SECRET!,
        },
        schemaRegistry: {
          apiKey: env.SCHEMA_REGISTRY_API_KEY!,
          apiSecret: env.SCHEMA_REGISTRY_API_SECRET!,
        },
        kafka: {
          apiKey: env.KAFKA_API_KEY!,
          apiSecret: env.KAFKA_API_SECRET!,
        },
      },
    });

    const filteredToolNames = getFilteredToolNames(cliOptions);

    // If --list-tools is set, print tool names with descriptions and exit
    if (cliOptions.listTools) {
      const MAX_DESC_LENGTH = 120;
      filteredToolNames.forEach((toolName) => {
        const config = ToolFactory.getToolConfig(toolName);
        let desc = config.description.replace(/\s+/g, " ").trim();
        if (desc.length > MAX_DESC_LENGTH) {
          desc = desc.slice(0, MAX_DESC_LENGTH - 3) + "...";
        }
        console.log(`\x1b[32m${config.name}\x1b[0m: ${desc}`);
      });
      process.exit(0);
    }

    const toolHandlers = new Map<ToolName, ToolHandler>();

    // Initialize tools and check their requirements
    Object.values(ToolName).forEach((toolName) => {
      if (!filteredToolNames.includes(toolName)) {
        logger.warn(`Tool ${toolName} disabled due to allow/block list rules`);
        return;
      }
      const handler = ToolFactory.createToolHandler(toolName);
      // Skip cloud-only tools if disabled by CLI/env
      if (
        cliOptions.disableConfluentCloudTools &&
        handler.isConfluentCloudOnly()
      ) {
        logger.warn(
          `Tool ${toolName} disabled due to --disable-confluent-cloud-tools flag or DISABLE_CONFLUENT_CLOUD_TOOLS env var`,
        );
        return;
      }
      const missingVars = handler
        .getRequiredEnvVars()
        .filter((varName: EnvVar) => !env[varName]);

      if (missingVars.length === 0) {
        toolHandlers.set(toolName, handler);
        logger.info(`Tool ${toolName} enabled`);
      } else {
        logger.warn(
          `Tool ${toolName} disabled due to missing environment variables: ${missingVars.join(", ")}`,
        );
      }
    });

    const server = new McpServer({
      name: "confluent",
      version: getPackageVersion(),
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

    const promptHandlers = PromptFactory.getPromptHandlers();
    // Register prompts with proper schema validation
    promptHandlers.forEach((promptHandler) => {
      const config = promptHandler.getPromptConfig();
      const schema = promptHandler.getSchema();

      server.prompt(config.name, config.inputSchema, async (args) => {
        // Parse and validate arguments using the handler's schema
        const validatedArgs = schema.parse(args) as Record<string, unknown>;

        // Execute the prompt handler
        const result = await promptHandler.handle(clientManager, validatedArgs);

        // Convert the handler result to MCP prompt response format
        return {
          messages: result.content.map((content) => ({
            role: "user" as const,
            content:
              content.type === "text"
                ? {
                    type: "text" as const,
                    text: content.text || "",
                  }
                : {
                    type: "resource" as const,
                    resource: {
                      uri: content.resource!.uri,
                      text: content.resource!.name,
                      mimeType: content.resource?.mimeType,
                    },
                  },
          })),
        };
      });
    });

    const transportManager = new TransportManager(server);

    // Start all transports with a single call
    logger.info(`Starting transports: ${cliOptions.transports.join(", ")}`);
    await transportManager.start(
      cliOptions.transports,
      env.HTTP_PORT,
      env.HTTP_HOST,
    );

    // Set up cleanup handlers
    const performCleanup = async () => {
      logger.info("Shutting down...");
      await transportManager.stop();
      await clientManager.disconnect();
      await server.close();
      process.exit(0);
    };

    process.on("SIGINT", performCleanup);
    process.on("SIGTERM", performCleanup);
    process.on("SIGQUIT", performCleanup);
    process.on("SIGUSR2", performCleanup);
  } catch (error) {
    logger.error({ err: error }, "Error starting server");
    process.exit(1);
  }
}

main().catch((error) => {
  logger.error({ error }, "Error starting server");
  process.exit(1);
});
