/**
 * Shared setup for integration tests.
 *
 * Loads environment variables from `.env.integration` (falls back to `.env`),
 * builds a real {@link DefaultClientManager}, and exposes helpers for calling
 * tools via the MCP protocol and for hitting Confluent Cloud REST APIs directly
 * so test assertions can cross-check tool responses.
 */

import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { DefaultClientManager } from "@src/confluent/client-manager.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { initEnv, type Environment } from "@src/env.js";
import { createTestServer, type TestServerContext } from "../server.js";

// ---------------------------------------------------------------------------
// Environment loading
// ---------------------------------------------------------------------------

/** Load env files before anything else touches `process.env`. */
function loadEnvFiles() {
  const root = resolve(import.meta.dirname, "../..");
  // .env.integration takes precedence; .env is the fallback
  loadDotenv({ path: resolve(root, ".env"), override: false });
  loadDotenv({ path: resolve(root, ".env.integration"), override: true });
}

// Eagerly load env files so requireEnvVars() works before setupIntegration()
loadEnvFiles();

// ---------------------------------------------------------------------------
// Guard helpers – skip suites when credentials are missing
// ---------------------------------------------------------------------------

export function requireEnvVars(...vars: string[]): void {
  const missing = vars.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required env vars for this test suite: ${missing.join(", ")}. ` +
        `Provide them in .env.integration or .env.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Client manager factory
// ---------------------------------------------------------------------------

export function createClientManager(env: Environment): DefaultClientManager {
  const kafkaConfig: Record<string, unknown> = {
    "bootstrap.servers": env.BOOTSTRAP_SERVERS ?? "",
    "client.id": "mcp-integration-test",
  };
  if (env.KAFKA_API_KEY && env.KAFKA_API_SECRET) {
    Object.assign(kafkaConfig, {
      "security.protocol": "sasl_ssl",
      "sasl.mechanisms": "PLAIN",
      "sasl.username": env.KAFKA_API_KEY,
      "sasl.password": env.KAFKA_API_SECRET,
    });
  }

  return new DefaultClientManager({
    kafka: kafkaConfig as import("@confluentinc/kafka-javascript").GlobalConfig,
    endpoints: {
      cloud: env.CONFLUENT_CLOUD_REST_ENDPOINT,
      flink: env.FLINK_REST_ENDPOINT,
      schemaRegistry: env.SCHEMA_REGISTRY_ENDPOINT,
      kafka: env.KAFKA_REST_ENDPOINT,
      telemetry:
        env.TELEMETRY_ENDPOINT ?? "https://api.telemetry.confluent.cloud",
    },
    auth: {
      cloud: {
        apiKey: env.CONFLUENT_CLOUD_API_KEY!,
        apiSecret: env.CONFLUENT_CLOUD_API_SECRET!,
      },
      tableflow: {
        apiKey: env.TABLEFLOW_API_KEY!,
        apiSecret: env.TABLEFLOW_API_SECRET!,
      },
      flink: {
        apiKey: env.FLINK_API_KEY!,
        apiSecret: env.FLINK_API_SECRET!,
      },
      schemaRegistry: {
        apiKey: env.SCHEMA_REGISTRY_API_KEY!,
        apiSecret: env.SCHEMA_REGISTRY_API_SECRET!,
      },
      kafka: {
        apiKey: env.KAFKA_API_KEY!,
        apiSecret: env.KAFKA_API_SECRET!,
      },
      telemetry: {
        apiKey: (env.TELEMETRY_API_KEY ?? env.CONFLUENT_CLOUD_API_KEY)!,
        apiSecret: (env.TELEMETRY_API_SECRET ??
          env.CONFLUENT_CLOUD_API_SECRET)!,
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Direct REST helpers for verification
// ---------------------------------------------------------------------------

interface RestOptions {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
}

function basicAuth(apiKey: string, apiSecret: string): string {
  return `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`;
}

/** Thin wrapper around `fetch` for calling Confluent Cloud REST APIs directly. */
export async function restGet(
  path: string,
  opts: RestOptions,
): Promise<unknown> {
  const url = `${opts.baseUrl}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: basicAuth(opts.apiKey, opts.apiSecret),
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(
      `REST GET ${path} failed: ${res.status} ${await res.text()}`,
    );
  }
  return res.json();
}

export async function restDelete(
  path: string,
  opts: RestOptions,
): Promise<unknown> {
  const url = `${opts.baseUrl}${path}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: {
      Authorization: basicAuth(opts.apiKey, opts.apiSecret),
      "Content-Type": "application/json",
    },
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(
      `REST DELETE ${path} failed: ${res.status} ${await res.text()}`,
    );
  }
  return res.status === 204 ? null : res.json().catch(() => null);
}

export async function restPost(
  path: string,
  body: unknown,
  opts: RestOptions,
): Promise<unknown> {
  const url = `${opts.baseUrl}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: basicAuth(opts.apiKey, opts.apiSecret),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      `REST POST ${path} failed: ${res.status} ${await res.text()}`,
    );
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// MCP tool call helper
// ---------------------------------------------------------------------------

export function toolText(
  result: Awaited<ReturnType<Client["callTool"]>>,
): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  const textContent = content.find((c) => c.type === "text");
  return textContent?.text ?? "";
}

// ---------------------------------------------------------------------------
// Integration test context
// ---------------------------------------------------------------------------

export interface IntegrationContext {
  env: Environment;
  clientManager: DefaultClientManager;
  testServer: TestServerContext;
  client: Client;
  /** REST opts pre-configured for the Kafka REST API */
  kafkaRest: RestOptions;
  /** REST opts pre-configured for the Schema Registry API */
  schemaRegistryRest: RestOptions;
  /** REST opts pre-configured for the Confluent Cloud API */
  cloudRest: RestOptions;
}

/**
 * Boot the full integration context. Call once in `beforeAll`.
 * The returned `shutdown` tears everything down.
 */
export async function setupIntegration(
  toolNames?: ToolName[],
): Promise<IntegrationContext> {
  loadEnvFiles();
  const env = await initEnv();
  const clientManager = createClientManager(env);
  const testServer = await createTestServer(clientManager, toolNames);

  return {
    env,
    clientManager,
    testServer,
    client: testServer.client,
    kafkaRest: {
      baseUrl: env.KAFKA_REST_ENDPOINT ?? "",
      apiKey: env.KAFKA_API_KEY ?? "",
      apiSecret: env.KAFKA_API_SECRET ?? "",
    },
    schemaRegistryRest: {
      baseUrl: env.SCHEMA_REGISTRY_ENDPOINT ?? "",
      apiKey: env.SCHEMA_REGISTRY_API_KEY ?? "",
      apiSecret: env.SCHEMA_REGISTRY_API_SECRET ?? "",
    },
    cloudRest: {
      baseUrl:
        env.CONFLUENT_CLOUD_REST_ENDPOINT ?? "https://api.confluent.cloud",
      apiKey: env.CONFLUENT_CLOUD_API_KEY ?? "",
      apiSecret: env.CONFLUENT_CLOUD_API_SECRET ?? "",
    },
  };
}

export async function teardownIntegration(ctx: IntegrationContext) {
  await ctx.testServer.shutdown();
  await ctx.clientManager.disconnect();
}

// ---------------------------------------------------------------------------
// Unique test-run prefix to avoid collisions
// ---------------------------------------------------------------------------

const RUN_ID = `inttest-${Date.now().toString(36)}`;

/** Returns a topic name scoped to this test run. */
export function testTopicName(suffix: string): string {
  return `${RUN_ID}-${suffix}`;
}

/** Returns a subject name scoped to this test run. */
export function testSubjectName(suffix: string): string {
  return `${RUN_ID}-${suffix}`;
}
