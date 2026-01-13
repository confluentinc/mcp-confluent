import { Command, CommanderError, Option } from "@commander-js/extra-typings";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { logger } from "@src/logger.js";
import { TransportType } from "@src/mcp/transports/types.js";
import * as dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { getProperties, KeyValuePairObject } from "properties-file";
import pkg from "../package.json" with { type: "json" };

// Define the interface for our CLI options
export interface CLIOptions {
  envFile?: string;
  transports: TransportType[];
  allowTools?: string[];
  blockTools?: string[];
  listTools?: boolean;
  disableConfluentCloudTools?: boolean;
  kafkaConfig: KeyValuePairObject;
  disableAuth?: boolean;
  allowedHosts?: string[];
  generateKey?: boolean;
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
 * Parses a comma-separated list of tool names and returns an array of valid tool names.
 * Trims whitespace from each tool name.
 * Exits the process with an error if any invalid tool names are provided.
 *
 * @param value - Comma-separated list of tool names
 * @returns Array of valid tool names
 */
function parseToolList(value: string): string[] {
  return (
    value
      .split(",")
      .map((t) => t.trim())
      // Filter out any empty strings that may result from extra commas or whitespace
      .filter(Boolean)
  );
}

/**
 * Reads a file and returns an array of non-empty, non-comment lines.
 * Lines starting with '#' are treated as comments and ignored.
 * Trims whitespace from each line.
 * Exits the process with an error if the file does not exist.
 *
 * @param filePath - Path to the file to read
 * @returns Array of valid lines from the file
 */
function readFileLines(filePath: string): string[] {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Tool list file not found: ${absPath}`);
  }
  const lines = fs
    .readFileSync(absPath, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  return lines;
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
    .option(
      "-k, --kafka-config-file <file>",
      "Path to a properties file for configuring kafka clients",
    )
    .addOption(
      new Option(
        "-t, --transport <types>",
        "Transport types (comma-separated list)",
      )
        .choices(Object.values(TransportType))
        .default(TransportType.STDIO)
        .argParser((value) => parseTransportList(value)),
    )
    .option(
      "--allow-tools <tools>",
      "Comma-separated list of tool names to allow. If provided, takes precedence over --allow-tools-file. Allow-list is applied before block-list.",
    )
    .option(
      "--block-tools <tools>",
      "Comma-separated list of tool names to block. If provided, takes precedence over --block-tools-file. Block-list is applied after allow-list.",
    )
    .option(
      "--allow-tools-file <file>",
      "File with tool names to allow (one per line). Used only if --allow-tools is not provided. Allow-list is applied before block-list.",
    )
    .option(
      "--block-tools-file <file>",
      "File with tool names to block (one per line). Used only if --block-tools is not provided. Block-list is applied after allow-list.",
    )
    .option(
      "--list-tools",
      "Print the final set of enabled tool names (with descriptions) after allow/block filtering and exit. Does not start the server.",
    )
    .option(
      "--disable-confluent-cloud-tools",
      "Disable all tools that require Confluent Cloud REST APIs (cloud-only tools).",
    )
    .option(
      "--disable-auth",
      "Disable authentication for HTTP/SSE transports. WARNING: Only use in development environments.",
    )
    .option(
      "--allowed-hosts <hosts>",
      "Comma-separated list of allowed Host header values for DNS rebinding protection (e.g., 'localhost,127.0.0.1,myhost.local').",
    )
    .option(
      "--generate-key",
      "Generate a secure API key for MCP_API_KEY and print it to stdout, then exit. Use this to create a key for your .env file.",
    )
    .allowExcessArguments(false)
    .exitOverride();

  try {
    const opts = program.parse().opts();
    if (opts.envFile) {
      loadEnvironmentVariables(opts.envFile);
    }
    // Precedence: CLI > file > undefined
    let allowTools: string[] | undefined = undefined;
    let blockTools: string[] | undefined = undefined;
    if (opts.allowTools) {
      allowTools = parseToolList(opts.allowTools);
    } else if (opts.allowToolsFile) {
      allowTools = readFileLines(opts.allowToolsFile);
    }
    if (opts.blockTools) {
      blockTools = parseToolList(opts.blockTools);
    } else if (opts.blockToolsFile) {
      blockTools = readFileLines(opts.blockToolsFile);
    }
    let kafkaConfig: KeyValuePairObject = {};
    if (opts.kafkaConfigFile) {
      kafkaConfig = parsePropertiesFile(opts.kafkaConfigFile);
    }
    return {
      envFile: opts.envFile,
      transports: Array.isArray(opts.transport)
        ? opts.transport
        : [opts.transport],
      allowTools,
      blockTools,
      listTools: !!opts.listTools,
      disableConfluentCloudTools: !!opts.disableConfluentCloudTools,
      kafkaConfig: kafkaConfig,
      disableAuth: !!opts.disableAuth,
      allowedHosts: opts.allowedHosts
        ? opts.allowedHosts
            .split(",")
            .map((h: string) => h.trim().toLowerCase())
        : undefined,
      generateKey: !!opts.generateKey,
    };
  } catch (error: unknown) {
    if (
      error instanceof CommanderError &&
      (error.code === "commander.helpDisplayed" ||
        error.code === "commander.version")
    ) {
      process.exit(0);
    }
    if (error instanceof Error) {
      logger.error(
        {
          error,
          errorString: error.toString(),
          errorMessage: error.message,
        },
        "Error parsing CLI options",
      );
    } else {
      logger.error({ error: String(error) }, "Error parsing CLI options");
    }
    process.exit(1);
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
    throw new Error(`Environment file not found: ${envPath}`);
  }

  // Load environment variables from file
  const result = dotenv.config({ path: envPath });

  if (result.error) {
    throw new Error(`Error loading environment variables: ${result.error}`);
  }

  logger.info(`Loaded environment variables from ${envPath}`);
}

/**
 * Filters and returns a sorted list of enabled ToolNames based on CLI allow/block options.
 *
 * This function determines which tools should be enabled for the server by applying
 * the following logic:
 *   1. If an allow list (`cliOptions.allowTools`) is provided and non-empty, only those
 *      tool names present in the allow list (and valid) will be enabled. Any invalid
 *      tool names in the allow list are ignored and a warning is logged.
 *   2. If a block list (`cliOptions.blockTools`) is provided and non-empty, any tool
 *      names present in the block list (and valid) will be removed from the enabled
 *      set. Any invalid tool names in the block list are ignored and a warning is logged.
 *   3. If neither allow nor block lists are provided, all available tools are enabled.
 *
 * The returned list is always sorted alphabetically.
 *
 * @param cliOptions - The parsed CLI options containing allow/block tool lists.
 * @returns An alphabetically sorted array of enabled ToolNames.
 */
export function getFilteredToolNames(cliOptions: CLIOptions): ToolName[] {
  let filteredToolNames: ToolName[] = Object.values(ToolName);
  const validToolNames = new Set(Object.values(ToolName));

  if (cliOptions.allowTools && cliOptions.allowTools.length > 0) {
    const valid = cliOptions.allowTools.filter((t) =>
      validToolNames.has(t as ToolName),
    );
    const invalid = cliOptions.allowTools.filter(
      (t) => !validToolNames.has(t as ToolName),
    );
    if (invalid.length > 0) {
      logger.warn(
        `Ignoring invalid tool names in allow list: ${invalid.join(", ")}`,
      );
    }
    filteredToolNames = valid.map((t) => t as ToolName);
  }
  if (cliOptions.blockTools && cliOptions.blockTools.length > 0) {
    const validBlock = cliOptions.blockTools.filter((t) =>
      validToolNames.has(t as ToolName),
    );
    const invalidBlock = cliOptions.blockTools.filter(
      (t) => !validToolNames.has(t as ToolName),
    );
    if (invalidBlock.length > 0) {
      logger.warn(
        `Ignoring invalid tool names in block list: ${invalidBlock.join(", ")}`,
      );
    }
    filteredToolNames = filteredToolNames.filter(
      (t) => !validBlock.includes(t),
    );
  }
  // Deduplicate and sort
  const deduped = Array.from(new Set(filteredToolNames)).sort();
  if (
    (!cliOptions.allowTools || cliOptions.allowTools.length === 0) &&
    (!cliOptions.blockTools || cliOptions.blockTools.length === 0)
  ) {
    logger.info(
      "No allow/block tool lists provided; all tools are enabled by default.",
    );
  }
  return deduped;
}

/**
 * Loads configuration from a properties file
 * @param filePath - Path to the properties file
 * @returns configuration object
 */
export function parsePropertiesFile(filePath: string): KeyValuePairObject {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Properties file not found: ${absPath}`);
  }
  try {
    const properties: KeyValuePairObject = getProperties(
      fs.readFileSync(absPath, "utf-8"),
    );
    return properties;
  } catch (err) {
    throw new Error(
      `Failed to parse properties file: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
