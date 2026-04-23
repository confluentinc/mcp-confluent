#!/usr/bin/env node

import { GlobalConfig } from "@confluentinc/kafka-javascript";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  DisplayedCommandLineUsageError,
  getFilteredToolNames,
  getPackageVersion,
  loadDotEnvIntoProcessEnv,
  parseCliArgs,
} from "@src/cli.js";
import {
  consConfigFromEnv,
  loadConfigFromYaml,
  MCPServerConfiguration,
  type DirectConnectionConfig,
} from "@src/config/index.js";
import { DefaultClientManager } from "@src/confluent/client-manager.js";
import { TelemetryEvent, TelemetryService } from "@src/confluent/telemetry.js";
import { ToolHandler } from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ToolHandlerRegistry } from "@src/confluent/tools/tool-registry.js";
import { EnvVar } from "@src/env-schema.js";
import type { Environment } from "@src/env.js";
import { initEnv } from "@src/env.js";
import { logger, setLogLevel } from "@src/logger.js";
import { generateApiKey, TransportManager } from "@src/mcp/transports/index.js";

/**
 * Determine the subset of ToolHandlers to register based on the filtered tool names,
 * cloud tool settings, and environment variables
 **/
export function getToolHandlersToRegister(
  filteredToolNames: ToolName[],
  disableConfluentCloudTools: boolean,
  env: Environment,
): Map<ToolName, ToolHandler> {
  const toolHandlers = new Map<ToolName, ToolHandler>();

  Object.values(ToolName).forEach((toolName) => {
    // Skip names that are not in the filtered list of tool names provided.
    if (!filteredToolNames.includes(toolName)) {
      logger.warn(`Tool ${toolName} disabled due to allow/block list rules`);
      return;
    }

    const handler = ToolHandlerRegistry.getToolHandler(toolName);

    // Skip cloud-only tools if disabled by CLI/env
    if (disableConfluentCloudTools && handler.isConfluentCloudOnly()) {
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

  // Raise an error if no tools are enabled, as the server would be non-functional without any tools.
  if (toolHandlers.size === 0) {
    throw new Error(
      "No tools enabled. Please check your configuration and environment variables.",
    );
  }

  return toolHandlers;
}

export function outputApiKey(): void {
  const apiKey = generateApiKey();
  console.log("\nGenerated MCP API Key:");
  console.log("=".repeat(64));
  console.log(apiKey);
  console.log("=".repeat(64));
  console.log("\nAdd this to your .env file:");
  console.log(`MCP_API_KEY=${apiKey}\n`);
}

export function outputToolList(filteredToolNames: ToolName[]): void {
  const MAX_DESC_LENGTH = 120;
  filteredToolNames.forEach((toolName) => {
    const config = ToolHandlerRegistry.getToolConfig(toolName);
    let desc = config.description.replaceAll(/\s+/g, " ").trim();
    if (desc.length > MAX_DESC_LENGTH) {
      desc = desc.slice(0, MAX_DESC_LENGTH - 3) + "...";
    }
    console.log(`\x1b[32m${config.name}\x1b[0m: ${desc}`);
  });
}

export function constructDefaultClientManager(
  conn: DirectConnectionConfig,
): DefaultClientManager {
  const kafkaClientConfig: GlobalConfig = {
    "client.id": "mcp-confluent",
    ...(conn.kafka?.bootstrap_servers && {
      "bootstrap.servers": conn.kafka.bootstrap_servers,
    }),
    ...(conn.kafka?.auth
      ? {
          "security.protocol": "sasl_ssl",
          "sasl.mechanisms": "PLAIN",
          "sasl.username": conn.kafka.auth.key,
          "sasl.password": conn.kafka.auth.secret,
        }
      : {}),
    ...(conn.kafka?.extra_properties ?? {}),
  };

  return new DefaultClientManager({
    kafka: kafkaClientConfig,
    endpoints: {
      cloud: conn.confluent_cloud?.endpoint,
      flink: conn.flink?.endpoint,
      schemaRegistry: conn.schema_registry?.endpoint,
      kafka: conn.kafka?.rest_endpoint,
      telemetry: conn.telemetry?.endpoint,
    },
    auth: {
      cloud: {
        apiKey: conn.confluent_cloud?.auth.key,
        apiSecret: conn.confluent_cloud?.auth.secret,
      },
      tableflow: {
        apiKey: conn.tableflow?.auth.key,
        apiSecret: conn.tableflow?.auth.secret,
      },
      flink: {
        apiKey: conn.flink?.auth.key,
        apiSecret: conn.flink?.auth.secret,
      },
      schemaRegistry: {
        apiKey: conn.schema_registry?.auth?.key,
        apiSecret: conn.schema_registry?.auth?.secret,
      },
      kafka: {
        apiKey: conn.kafka?.auth?.key,
        apiSecret: conn.kafka?.auth?.secret,
      },
      telemetry: {
        apiKey: conn.telemetry?.auth.key,
        apiSecret: conn.telemetry?.auth.secret,
      },
    },
  });
}

async function main() {
  try {
    // Parse command line arguments.(NO LONGER LOADS ENV VARS FROM -e file!)
    const cliOptions = parseCliArgs(process.argv);

    // Handle early-exit modes as requested by CLI args before initializing the server.
    if (cliOptions.generateKey) {
      outputApiKey();
      process.exit(0);
    }

    const filteredToolNames = getFilteredToolNames(
      cliOptions.allowTools ?? [],
      cliOptions.blockTools ?? [],
    );

    // If --list-tools is set, print the filtered tool names with descriptions and exit.
    if (cliOptions.listTools) {
      outputToolList(filteredToolNames);
      process.exit(0);
    }

    if (cliOptions.envFile) {
      // NOW load env vars into process.env!
      loadDotEnvIntoProcessEnv(cliOptions.envFile);
    }

    // Convert our known env vars into a typed Environment obj.
    const env = initEnv();
    setLogLevel(env.LOG_LEVEL);

    let mcpConfig: MCPServerConfiguration;
    // Load and validate configuration — from YAML file if --config provided, else from env vars.
    if (cliOptions.config) {
      mcpConfig = loadConfigFromYaml(cliOptions.config, process.env);
    } else {
      mcpConfig = consConfigFromEnv(env);

      if (cliOptions.kafkaConfig) {
        mcpConfig.setKafkaExtraProperties(cliOptions.kafkaConfig);
      }
    }

    logger.info(
      `${mcpConfig.getConnectionNames().length} connections loaded successfully`,
    );

    const clientManager = constructDefaultClientManager(
      mcpConfig.getSoleConnection(),
    );

    const serverVersion = getPackageVersion();
    const server = new McpServer({
      name: "confluent",
      version: serverVersion,
    });

    TelemetryService.getInstance().setCommonProperties({
      serverVersion,
      transportType: cliOptions.transports.join(","),
    });

    // Capture MCP client info when the handshake completes.
    server.server.oninitialized = () => {
      const clientInfo = server.server.getClientVersion();
      TelemetryService.getInstance().setCommonProperties({
        clientName: clientInfo?.name,
        clientVersion: clientInfo?.version,
      });
    };

    const toolHandlers = getToolHandlersToRegister(
      filteredToolNames,
      cliOptions.disableConfluentCloudTools ?? false,
      env,
    );

    logger.info(
      { enabledTools: [...toolHandlers.keys()] },
      `${toolHandlers.size} tool(s) enabled`,
    );

    toolHandlers.forEach((handler, name) => {
      const config = handler.getToolConfig();

      server.registerTool(
        name as string,
        {
          description: config.description,
          inputSchema: config.inputSchema,
          annotations: config.annotations,
        },
        async (args, context) => {
          const sessionId = context?.sessionId;
          const startTime = Date.now();
          try {
            const result = await handler.handle(clientManager, args, sessionId);
            TelemetryService.getInstance().track(TelemetryEvent.TOOL_CALL, {
              toolName: name,
              durationMs: Date.now() - startTime,
              status: result.isError ? "error" : "success",
            });
            return result;
          } catch (error) {
            TelemetryService.getInstance().track(TelemetryEvent.TOOL_CALL, {
              toolName: name,
              durationMs: Date.now() - startTime,
              status: "error",
            });
            throw error;
          }
        },
      );
    });

    // Prepare auth configuration
    const disableAuth = cliOptions.disableAuth || env.MCP_AUTH_DISABLED;
    const allowedHosts = cliOptions.allowedHosts || env.MCP_ALLOWED_HOSTS;
    const apiKey = env.MCP_API_KEY;

    // Warn if auth is disabled
    if (disableAuth) {
      logger.warn(
        "Authentication is DISABLED for HTTP/SSE transports. " +
          "This should only be used in development environments.",
      );
    }

    const transportManager = new TransportManager(server, {
      disableAuth,
      allowedHosts,
      apiKey,
    });

    // Start all transports with a single call
    logger.info(`Starting transports: ${cliOptions.transports.join(", ")}`);
    await transportManager.start(
      cliOptions.transports,
      env.HTTP_PORT,
      env.HTTP_HOST,
      env.HTTP_MCP_ENDPOINT_PATH,
      env.SSE_MCP_ENDPOINT_PATH,
      env.SSE_MCP_MESSAGE_ENDPOINT_PATH,
    );

    // Set up cleanup handlers
    const performCleanup = async () => {
      logger.info("Shutting down...");
      await TelemetryService.getInstance().shutdown();
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
    if (error instanceof DisplayedCommandLineUsageError) {
      process.exit(0);
    }
    logger.error({ err: error }, "Error starting server");
    process.exit(1);
  }
}

if (process.env.NODE_ENV !== "test") {
  await main();
}
