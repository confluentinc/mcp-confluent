import { GlobalConfig, KafkaJS } from "@confluentinc/kafka-javascript";

// mirrors the kafkaClientConfig built in src/index.ts so tests connect the
// same way the server does. we build from process.env directly rather than
// going through env-schema so this helper can be called outside the server's
// initEnv() lifecycle.
function kafkaConfig(clientId: string): GlobalConfig {
  return {
    "bootstrap.servers": process.env.BOOTSTRAP_SERVERS!,
    "client.id": clientId,
    "security.protocol": "sasl_ssl",
    "sasl.mechanisms": "PLAIN",
    "sasl.username": process.env.KAFKA_API_KEY!,
    "sasl.password": process.env.KAFKA_API_SECRET!,
  };
}

// No-op logger for test-side Kafka clients. Integration tests care about the
// server's logs (visible via stdio's inherited stderr or HTTP's stderr buffer);
// the test-side admin/producer is just shuttling resources to Kafka and its
// librdkafka-level telemetry would otherwise leak to the test runner's stdout
// via KafkaJS's default console fallback.
const silentKafkaLogger: KafkaJS.Logger = {
  namespace: () => silentKafkaLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  setLogLevel: () => {},
};

/**
 * Builds a {@link KafkaJS.Kafka} client. The library accepts either rdkafka-style
 * (top-level keys like `bootstrap.servers`) or kafkajs-style (nested `kafkaJS`
 * object); we use rdkafka-style so the `kafkaJS` field only carries the logger
 * override.
 */
function newKafkaClient(clientId: string): KafkaJS.Kafka {
  return new KafkaJS.Kafka({
    ...kafkaConfig(clientId),
    // no need to pass 'brokers' here because the rdkafka-style config is already
    // doing that via 'bootstrap.servers'
    kafkaJS: { logger: silentKafkaLogger } as KafkaJS.KafkaConfig,
  });
}

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
