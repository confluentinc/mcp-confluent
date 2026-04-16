import { interpolateValues } from "@src/config/interpolation.js";
import { MCPServerConfiguration, mcpConfigSchema } from "@src/config/models.js";
import * as nodeDeps from "@src/confluent/node-deps.js";
import path from "node:path";
import { parse as parseYaml } from "yaml";

export type { MCPServerConfiguration } from "@src/config/models.js";

/**
 * Loads and validates an MCP server configuration from a YAML file.
 *
 * @param filePath - Path to the YAML configuration file
 * @param env      - Environment variables used for ${VAR} interpolation
 * @returns Validated MCPServerConfiguration object
 * @throws Error if file doesn't exist, YAML is invalid, interpolation fails, or validation fails
 */
export function loadConfigFromYaml(
  filePath: string,
  env: Record<string, string | undefined>,
): MCPServerConfiguration {
  const yamlContent = loadConfigFileContents(filePath);
  return parseYamlConfiguration(yamlContent, env);
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
 * Always performs ${VAR} and ${VAR:-default} interpolation before Zod validation.
 *
 * @param yamlContent - YAML string content
 * @param env         - Environment variables used for ${VAR} interpolation
 * @returns Validated MCPServerConfiguration object
 * @throws Error if YAML is invalid, interpolation fails, or validation fails
 */
export function parseYamlConfiguration(
  yamlContent: string,
  env: Record<string, string | undefined>,
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

  // Interpolate environment variables (before Zod sees the values)
  try {
    parsedYaml = interpolateValues(parsedYaml, env);
  } catch (error) {
    throw new Error(
      `Failed to interpolate configuration values: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Validate with Zod
  const validationResult = mcpConfigSchema.safeParse(parsedYaml);

  if (!validationResult.success) {
    const errors = validationResult.error.issues
      .map((issue) => {
        const path = issue.path.join(".");
        return path ? `  - ${path}: ${issue.message}` : `  - ${issue.message}`;
      })
      .join("\n");
    throw new Error(`Configuration validation failed:\n${errors}`);
  }

  return validationResult.data;
}
