import { combinedSchema } from "@src/env-schema.js";
import { readFile } from "fs/promises";
import { z } from "zod";

// Load and validate environment variables
const envVars = combinedSchema.parse(process.env);

let env: z.infer<typeof combinedSchema> = { ...envVars };
try {
  const fileContent = await readFile(env.CONFIG_PATH, "utf-8");
  // Merge the file config with existing env vars
  env = combinedSchema.parse({
    ...env,
    ...JSON.parse(fileContent),
  });
} catch (error) {
  console.warn(
    `Failed to load config from ${env.CONFIG_PATH} due to ${error}, using empty config`,
  );
}

export type Environment = z.infer<typeof combinedSchema>;

export default env;
