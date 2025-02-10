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
  CONFIG_PATH: z
    .string()
    .optional()
    .default(`${import.meta.dirname}/config/default.json`),
  SCHEMA_REGISTRY_API_KEY: z.string().trim().min(1),
  SCHEMA_REGISTRY_API_SECRET: z.string().trim().min(1),
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
    CONFLUENT_CLOUD_REST_ENDPOINT: z
      .string()
      .trim()
      .url()
      .default("https://api.confluent.cloud"),
    SCHEMA_REGISTRY_ENDPOINT: z.string().trim().url(),
  })
  .partial(); // Makes all fields optional

const combinedSchema = envSchema.merge(configSchema);

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
