import { combinedSchema } from "@src/env-schema.js";
import { logger } from "@src/logger.js";
import { z } from "zod";

export type Environment = z.infer<typeof combinedSchema>;

// Track if environment is initialized
let isInitialized = false;
let envValues: Environment = {} as Environment;

/**
 * Loads and validates environment variables
 * @returns Validated environment object
 */
export async function loadEnv(): Promise<Environment> {
  try {
    // Load and validate environment variables with automatic type conversion
    return combinedSchema.parse(process.env);
  } catch (error) {
    logger.error({ error }, "Environment validation error");
    process.exit(1);
  }
}

/**
 * Initialize environment and save the values
 */
export async function initEnv(): Promise<Environment> {
  if (!isInitialized) {
    envValues = await loadEnv();
    isInitialized = true;
  }
  return envValues;
}

// Create a module to provide access to environment variables
const env = new Proxy({} as Environment, {
  get: (_, property: string) => {
    if (!isInitialized) {
      throw new Error(
        `Environment not initialized. Attempted to access ${property} before initialization.`,
      );
    }
    return envValues[property as keyof Environment];
  },
});

export default env;
