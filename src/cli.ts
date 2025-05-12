import { Command, Option } from "@commander-js/extra-typings";
import { logger } from "@src/logger.js";
import { TransportType } from "@src/mcp/transports/types.js";
import * as dotenv from "dotenv";
import fs from "fs";
import path from "path";
import pkg from "../package.json" with { type: "json" };

// Define the interface for our CLI options
export interface CLIOptions {
  envFile?: string;
  transports: TransportType[];
}

/**
 * Get the package version from package.json
 * @returns Package version string
 */
export function getPackageVersion(): string {
  return pkg.version;
}

function parseTransportList(value: string): TransportType[] {
  // Split, trim, and filter out empty strings
  const types = value
    .split(",")
    .map((type) => type.trim())
    .filter(Boolean);

  // Validate each transport type
  const validTypes = new Set(Object.values(TransportType));
  const invalidTypes = types.filter(
    (type) => !validTypes.has(type as TransportType),
  );

  if (invalidTypes.length > 0) {
    throw new Error(
      `Invalid transport type(s): ${invalidTypes.join(", ")}. Valid options: ${Array.from(validTypes).join(", ")}`,
    );
  }

  // Deduplicate using Set
  return Array.from(new Set(types)) as TransportType[];
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
    .version(getPackageVersion())
    .option("-e, --env-file <path>", "Load environment variables from file")
    .addOption(
      new Option(
        "-t, --transport <types>",
        "Transport types (comma-separated list)",
      )
        .choices(Object.values(TransportType))
        .default(TransportType.STDIO)
        .argParser((value) => parseTransportList(value)),
    )
    .action((options) => {
      if (options.envFile) {
        loadEnvironmentVariables(options.envFile);
      }
    })
    .allowExcessArguments(false)
    .exitOverride();

  try {
    const opts = program.parse().opts();
    return {
      envFile: opts.envFile,
      transports: Array.isArray(opts.transport)
        ? opts.transport
        : [opts.transport],
    };
  } catch {
    // This block is reached when --help or --version is called
    // as these will throw an error due to exitOverride()
    process.exit(0);
  }
}

/**
 * Load environment variables from file
 * @param envFile Path to the environment file
 */
export function loadEnvironmentVariables(envFile: string): void {
  const envPath = path.resolve(envFile);

  // Check if file exists
  if (!fs.existsSync(envPath)) {
    logger.error(`Environment file not found: ${envPath}`);
    process.exit(1);
  }

  // Load environment variables from file
  const result = dotenv.config({ path: envPath });

  if (result.error) {
    logger.error(
      { error: result.error },
      "Error loading environment variables",
    );
    process.exit(1);
  }

  logger.info(`Loaded environment variables from ${envPath}`);
}
