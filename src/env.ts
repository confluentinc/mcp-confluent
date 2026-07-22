import { combinedSchema } from "@src/env-schema.js";
import { logger } from "@src/logger.js";
import type { z } from "zod";

export type Environment = z.infer<typeof combinedSchema>;

// Track if environment is initialized
let isInitialized = false;
let envValues: Environment = {} as Environment;

/**
 * Loads and validates environment variables
 * @returns Validated environment object
 */
function loadEnv(): Environment {
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
export function initEnv(): Environment {
  if (!isInitialized) {
    envValues = loadEnv();
    isInitialized = true;
  }
  return envValues;
}

/**
 * Lazy proxy over the validated environment values. Reading any property
 * before {@linkcode initEnv} has run throws — this is what catches code that
 * tries to consult the env outside the bootstrap.
 *
 * The default-export shape was retired in #234 to make accidental consumers
 * visibly fail at the import site, and an ESLint rule slams the door behind
 * it. The intended pattern is: `main()` calls `initEnv()` once, captures the
 * returned `Environment` into a local, and passes it explicitly to the few
 * call sites that need it. No global env consultation lives in handler code,
 * test infrastructure, or anywhere else.
 */
export const env = new Proxy({} as Environment, {
  get: (_, property: string) => {
    if (!isInitialized) {
      throw new Error(
        `Environment not initialized. Attempted to access ${property} before initialization.`,
      );
    }
    return envValues[property as keyof Environment];
  },
});
