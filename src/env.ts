import { readFile } from "fs/promises";
import { z } from "zod";

// Schema for required environment variables
const envSchema = z.object({
  BOOTSTRAP_SERVERS: z.string().trim(),
  KAFKA_API_KEY: z.string().trim().min(1),
  KAFKA_API_SECRET: z.string().trim().min(1),
  FLINK_API_KEY: z.string().trim().min(1),
  FLINK_API_SECRET: z.string().trim().min(1),
  CONFLUENT_CLOUD_API_KEY: z.string().trim().min(1),
  CONFLUENT_CLOUD_API_SECRET: z.string().trim().min(1),
  CONFIG_PATH: z.string().optional(),
});

// Schema for optional configuration from file
const configSchema = z
  .object({
    FLINK_ENV_ID: z.string().trim().startsWith("env-"),
    FLINK_ORG_ID: z.string().trim().min(1),
    FLINK_REST_ENDPOINT: z.string().trim().url(),
    FLINK_COMPUTE_POOL_ID: z.string().trim().startsWith("lfcp-"),
    FLINK_ENV_NAME: z.string().trim().min(1),
    FLINK_DATABASE_NAME: z.string().trim().min(1),
    KAFKA_CLUSTER_ID: z.string().trim().min(1),
    KAFKA_ENV_ID: z.string().trim().startsWith("env-"),
    CONFLUENT_CLOUD_REST_ENDPOINT: z.string().trim().url(),
  })
  .partial(); // Makes all fields optional

// Load and validate environment variables
const envVars = envSchema.parse(process.env);

// Load and validate config file if it exists
const configPath =
  envVars.CONFIG_PATH || `${import.meta.dirname}/config/default.json`;

let config: z.infer<typeof configSchema> = {};
try {
  const fileContent = await readFile(configPath, "utf-8");
  config = configSchema.parse(JSON.parse(fileContent));
} catch (error) {
  console.warn(
    `Failed to load config from ${configPath} due to ${error}, using empty config`,
  );
}

// Combine env and config
const env = { ...envVars, ...config };

export type Environment = z.infer<typeof envSchema> &
  z.infer<typeof configSchema>;

export default env;
