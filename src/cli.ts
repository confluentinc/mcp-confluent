import { Command } from "@commander-js/extra-typings";
import { logger } from "@src/logger.js";
import * as dotenv from "dotenv";
import fs from "fs";
import os from "os";
import path from "path";

// Define the interface for our CLI options
export interface CLIOptions {
  envFile?: string;
  logDir?: string;
}

/**
 * Parse command line arguments with strong typing
 * @returns Parsed CLI options
 */
export function parseCliArgs(): CLIOptions {
  const program = new Command()
    .name("mcp-confluent")
    .description(
      "Confluent MCP Server - Model Context Protocol implementation for Confluent Cloud",
    )
    .version(process.env.npm_package_version ?? "dev")
    .option("-e, --env-file <path>", "Load environment variables from file")
    .option("-l, --log-dir <path>", "Directory for log files")
    .action((options) => {
      if (options.envFile) {
        loadEnvironmentVariables(options);
      }
    })
    .allowExcessArguments(false)
    .exitOverride();

  try {
    // Parse arguments and get options (no need for generic type parameter with extra-typings)
    return program.parse().opts();
  } catch {
    // This block is reached when --help or --version is called
    // as these will throw an error due to exitOverride()
    process.exit(0);
  }
}

/**
 * Get the log directory path, using CLI option if provided, otherwise default to user's home directory
 * Note: This function expects CLI options to be already parsed via parseCliArgs() in index.ts
 * @param cliOptions - The parsed CLI options from parseCliArgs()
 * @returns Path to the log directory
 */
export function getLogDir(cliOptions: CLIOptions): string {
  return cliOptions.logDir || path.join(os.homedir(), "mcp-confluent", "logs");
}

/**
 * Load environment variables from file if specified in options
 * @param options CLI options containing envFile path
 */
export function loadEnvironmentVariables(options: CLIOptions): void {
  if (options.envFile) {
    const envPath = path.resolve(options.envFile);

    // Check if file exists
    if (!fs.existsSync(envPath)) {
      logger.error(`Environment file not found: ${envPath}`);
      return;
    }

    // Load environment variables from file
    const result = dotenv.config({ path: envPath });

    if (result.error) {
      logger.error(
        { error: result.error },
        "Error loading environment variables",
      );
      return;
    }

    logger.info(`Loaded environment variables from ${envPath}`);
  }
}
