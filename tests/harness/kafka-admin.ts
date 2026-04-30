import { GlobalConfig, KafkaJS } from "@confluentinc/kafka-javascript";
import { integrationRuntime } from "@tests/harness/runtime.js";

/**
 * Connects a Kafka admin client directly (not via the MCP server) for
 * test-side resource lifecycle: creating topics in `beforeAll`, cleaning up
 * in `afterAll`, verifying topic state after a handler call, etc. Callers
 * must `admin.disconnect()` when done.
 */
export async function connectTestAdmin(): Promise<KafkaJS.Admin> {
  const admin = newKafkaClient("mcp-confluent-it-admin").admin();
  await admin.connect();
  return admin;
}

/**
 * Connects a Kafka producer directly for test-side seeding: producing
 * messages that a handler test will later consume via the server. Callers
 * must `producer.disconnect()` when done.
 */
export async function connectTestProducer(): Promise<KafkaJS.Producer> {
  const producer = newKafkaClient("mcp-confluent-it-producer").producer();
  await producer.connect();
  return producer;
}

/**
 * Generates a unique topic name with an `int-` prefix so stale resources from
 * failed test runs can be distinguished from production topics during
 * cleanup. Format: `int-<slug>-<timestamp>-<random>`, matching the `e2e-`
 * prefix convention used by confluentinc/vscode.
 */
export function uniqueTopicName(slug: string): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `int-${slug}-${Date.now()}-${random}`;
}

/**
 * Builds a {@link KafkaJS.Kafka} client. The library accepts either rdkafka-style
 * (top-level keys like `bootstrap.servers`) or kafkajs-style (nested `kafkaJS`
 * object); we use rdkafka-style so the `kafkaJS` field only carries the logger
 * override.
 */
function newKafkaClient(clientId: string): KafkaJS.Kafka {
  return new KafkaJS.Kafka({
    ...kafkaConfig(clientId),
    kafkaJS: { logger: silentKafkaLogger } as KafkaJS.KafkaConfig,
  });
}

// resolve from the same YAML fixture the server reads, so the test-side admin and the MCP server
// can never disagree on which cluster they're talking to
function kafkaConfig(clientId: string): GlobalConfig {
  const conn = Object.values(integrationRuntime().config.connections)[0];
  if (!conn?.kafka?.bootstrap_servers || !conn.kafka.auth) {
    throw new Error(
      "test-side kafka admin requires kafka.bootstrap_servers + kafka.auth in test-fixtures/yaml_configs/integration.yaml",
    );
  }
  return {
    "bootstrap.servers": conn.kafka.bootstrap_servers,
    "client.id": clientId,
    "security.protocol": "sasl_ssl",
    "sasl.mechanisms": "PLAIN",
    "sasl.username": conn.kafka.auth.key,
    "sasl.password": conn.kafka.auth.secret,
  };
}

// no-op logger for test-side Kafka clients: integration tests care about the
// server's logs, and librdkafka-level telemetry would otherwise leak to the
// runner's stdout via KafkaJS's default console fallback.
const silentKafkaLogger: KafkaJS.Logger = {
  namespace: () => silentKafkaLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  setLogLevel: () => {},
};
