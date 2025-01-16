import { z } from "zod";

// Define the schema as an object with all of the env
// variables and their types
const envSchema = z.object({
  BOOTSTRAP_SERVERS: z.string().trim().default("localhost:9092"),
  KAFKA_API_KEY: z.string().trim().min(1),
  KAFKA_API_SECRET: z.string().trim().min(1),
  FLINK_API_KEY: z.string().trim().min(1),
  FLINK_API_SECRET: z.string().trim().min(1),
  FLINK_ENV_ID: z.string().trim().startsWith("env-"),
  FLINK_ORG_ID: z.string().trim().min(1),
  FLINK_REST_ENDPOINT: z.string().trim().url(),
  FLINK_COMPUTE_POOL_ID: z.string().trim().startsWith("lfcp-"),
  FLINK_ENV_NAME: z.string().trim().min(1),
  FLINK_DATABASE_NAME: z.string().trim().min(1),
});

// Validate `process.env` against our schema
// and return the result
const env = envSchema.parse(process.env);

export type Environment = z.infer<typeof envSchema>;

export default env;
