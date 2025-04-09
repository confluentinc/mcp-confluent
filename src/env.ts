import { combinedSchema } from "@src/env-schema.js";
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
    // Load and validate environment variables
    const envVars = combinedSchema.parse(process.env);
    return envVars;
  } catch (error) {
    console.error("Environment validation error:", error);
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
    if (isInitialized) {
      return envValues[property as keyof Environment];
    }
    return undefined;
  },
});

export default env;
