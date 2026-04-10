import {
  ConnectionConfig,
  MCPServerConfiguration,
  mcpConfigSchema,
} from "@src/config/models.js";
import * as nodeDeps from "@src/confluent/node-deps.js";
import path from "node:path";
import { parse as parseYaml } from "yaml";

export type { MCPServerConfiguration } from "@src/config/models.js";

/**
 * Loads and validates an MCP server configuration from a YAML file.
 *
 * @param filePath - Path to the YAML configuration file
 * @returns Validated MCPServerConfiguration object
 * @throws Error if file doesn't exist, YAML is invalid, or validation fails
 */
export function loadConfigFromYaml(filePath: string): MCPServerConfiguration {
  const yamlContent = loadConfigFileContents(filePath);
  return parseYamlConfiguration(yamlContent);
}

/* All the rest of the functions in this file are internal helpers for loading and validating the configuration, only exported for
  test suite purposes. */

/**
 * Reads configuration file contents from disk.
 *
 * @param filePath - Path to the YAML configuration file
 * @returns File contents as string
 * @throws Error if file doesn't exist or cannot be read
 */
export function loadConfigFileContents(filePath: string): string {
  const absolutePath = path.resolve(filePath);

  // Check if file exists
  if (!nodeDeps.fs.existsSync(absolutePath)) {
    throw new Error(`Configuration file not found: ${absolutePath}`);
  }

  // Read file contents
  try {
    return nodeDeps.fs.readFileSync(absolutePath, "utf-8");
  } catch (error) {
    throw new Error(
      `Failed to read configuration file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Parses and validates YAML configuration content.
 *
 * @param yamlContent - YAML string content
 * @returns Validated MCPServerConfiguration object
 * @throws Error if YAML is invalid or validation fails
 */
export function parseYamlConfiguration(
  yamlContent: string,
): MCPServerConfiguration {
  // Parse YAML
  let parsedYaml: unknown;
  try {
    parsedYaml = parseYaml(yamlContent);
  } catch (error) {
    throw new Error(
      `Failed to parse YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Validate with Zod
  const validationResult = mcpConfigSchema.safeParse(parsedYaml);

  if (!validationResult.success) {
    const errors = validationResult.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Configuration validation failed:\n${errors}`);
  }

  const validated = validationResult.data;

  // Inject connectionId from YAML map key into each connection object
  const connections: Record<string, ConnectionConfig> = {};
  for (const [connectionId, connection] of Object.entries(
    validated.connections,
  )) {
    connections[connectionId] = {
      ...connection,
      connectionId,
    };
  }

  // Return as MCPServerConfiguration.
  return { connections };
}
