#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  DisplayedCommandLineUsageError,
  getFilteredToolNames,
  getPackageVersion,
  loadDotEnvIntoProcessEnv,
  parseCliArgs,
} from "@src/cli.js";
import {
  buildConfigFromEnvAndCli,
  loadConfigFromYaml,
  MCPServerConfiguration,
} from "@src/config/index.js";
import { TelemetryEvent, TelemetryService } from "@src/confluent/telemetry.js";
import { ToolHandler } from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ToolHandlerRegistry } from "@src/confluent/tools/tool-registry.js";
import { initEnv } from "@src/env.js";
import { logger, setLogLevel } from "@src/logger.js";
import { generateApiKey, TransportManager } from "@src/mcp/transports/index.js";
import { ServerRuntime } from "@src/server-runtime.js";

/**
 * Determine the subset of ToolHandlers to register based on the filtered tool names
 * and which connections satisfy each tool's service requirements.
 **/
export function getToolHandlersToRegister(
  filteredToolNames: ToolName[],
  runtime: ServerRuntime,
): Map<ToolName, ToolHandler> {
  const toolHandlers = new Map<ToolName, ToolHandler>();
  const knownIds = new Set(Object.keys(runtime.config.connections));

  Object.values(ToolName).forEach((toolName) => {
    // Skip names that are not in the filtered list of tool names provided.
    if (!filteredToolNames.includes(toolName)) {
      logger.warn(`Tool ${toolName} disabled due to allow/block list rules`);
      return;
    }

    const handler = ToolHandlerRegistry.getToolHandler(toolName);

    const enabledIds = handler.enabledConnectionIds(runtime);
    const unknownIds = enabledIds.filter((id) => !knownIds.has(id));
    if (unknownIds.length > 0) {
      throw new Error(
        `Tool ${toolName}: enabledConnectionIds() returned unknown connection ID(s): ${unknownIds.join(", ")}`,
      );
    }
    if (enabledIds.length > 0) {
      toolHandlers.set(toolName, handler);
      logger.info(`Tool ${toolName} enabled`);
    } else {
      logger.warn(
        `Tool ${toolName} disabled; no connections satisfy its requirements`,
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

    let mcpConfig: MCPServerConfiguration;
    // Load and validate configuration — from YAML file if --config provided, else from env vars + CLI overrides.
    if (cliOptions.config) {
      mcpConfig = loadConfigFromYaml(cliOptions.config, process.env);
    } else {
      mcpConfig = buildConfigFromEnvAndCli(env, {
        disableAuth: cliOptions.disableAuth,
        allowedHosts: cliOptions.allowedHosts,
        kafkaConfig: cliOptions.kafkaConfig,
        oauth: cliOptions.oauth,
        developmentEnv: cliOptions.developmentEnv,
      });
    }

    // --oauth + --config is rejected in both shapes the combination can take.
    // (a) YAML already declares an OAuth connection: ambiguous which env wins.
    // (b) YAML is direct-only: --oauth would be silently ignored, since we don't
    //     yet merge a synthesized OAuth connection into a multi-connection YAML.
    // When multi-connection support lands (#151), case (b) can become a merge.
    if (cliOptions.oauth && cliOptions.config) {
      const yamlHasOauth = Object.values(mcpConfig.connections).some(
        (c) => c.type === "oauth",
      );
      throw new Error(
        yamlHasOauth
          ? "--oauth conflicts with the OAuth connection already declared in the YAML config; remove one or the other"
          : "--oauth and --config cannot be combined: declare OAuth as a connection inside the YAML (type: oauth) instead of passing --oauth",
      );
    }

    setLogLevel(mcpConfig.server.log_level);

    // Transport selection: YAML config is authoritative when --config is used;
    // CLI flag (or its default) is used on the env-var path.
    const transports = cliOptions.config
      ? mcpConfig.server.transports
      : cliOptions.transports;

    // DO_NOT_TRACK is a cross-tool user preference (consoledonottrack.com);
    // the env var acts as a floor so it is honored even when --config is used.
    TelemetryService.initialize(
      mcpConfig.server.do_not_track || env.DO_NOT_TRACK,
    );

    logger.info(
      `${mcpConfig.getConnectionNames().length} connections loaded successfully`,
    );

    const runtime = ServerRuntime.fromConfig(mcpConfig);

    const serverVersion = getPackageVersion();
    const server = new McpServer({
      name: "confluent",
      version: serverVersion,
    });

    TelemetryService.getInstance().setCommonProperties({
      serverVersion,
      transportType: transports.join(","),
    });

    // Capture MCP client info when the handshake completes.
    server.server.oninitialized = () => {
      const clientInfo = server.server.getClientVersion();
      TelemetryService.getInstance().setCommonProperties({
        clientName: clientInfo?.name,
        clientVersion: clientInfo?.version,
      });
    };

    const toolHandlers = getToolHandlersToRegister(filteredToolNames, runtime);

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
            const result = await handler.handle(runtime, args, sessionId);
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

    // Warn if auth is disabled
    if (mcpConfig.server.auth.disabled) {
      logger.warn(
        "Authentication is DISABLED for HTTP/SSE transports. " +
          "This should only be used in development environments.",
      );
    }

    const transportManager = new TransportManager(server, {
      disableAuth: mcpConfig.server.auth.disabled,
      allowedHosts: mcpConfig.server.auth.allowed_hosts,
      apiKey: mcpConfig.server.auth.api_key,
    });

    // Start all transports with a single call
    logger.info(`Starting transports: ${transports.join(", ")}`);
    await transportManager.start(
      transports,
      mcpConfig.server.http.port,
      mcpConfig.server.http.host,
      mcpConfig.server.http.mcp_endpoint,
      mcpConfig.server.http.sse_endpoint,
      mcpConfig.server.http.sse_message_endpoint,
    );

    // Set up cleanup handlers
    const performCleanup = async () => {
      logger.info("Shutting down...");
      await TelemetryService.getInstance().shutdown();
      await transportManager.stop();
      // shutdown() is race-safe with an in-flight bootstrap.
      runtime.oauthHolder?.shutdown();
      await runtime.clientManager.disconnect();
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
