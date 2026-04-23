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
 * Connects a Kafka admin client directly (not via the MCP server) for
 * test-side resource lifecycle: creating topics in `beforeAll`, cleaning up
 * in `afterAll`, verifying topic state after a handler call, etc. Callers
 * must `admin.disconnect()` when done.
 */
export async function connectTestAdmin(): Promise<KafkaJS.Admin> {
  const kafka = new KafkaJS.Kafka({
    ...kafkaConfig("mcp-confluent-it-admin"),
    // typescript requires kafkaJS even though most config is above
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    kafkaJS: { logger: silentKafkaLogger } as any,
  });
  const admin = kafka.admin();
  await admin.connect();
  return admin;
}

/**
 * Connects a Kafka producer directly for test-side seeding: producing
 * messages that a handler test will later consume via the server. Callers
 * must `producer.disconnect()` when done.
 */
export async function connectTestProducer(): Promise<KafkaJS.Producer> {
  const kafka = new KafkaJS.Kafka({
    ...kafkaConfig("mcp-confluent-it-producer"),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    kafkaJS: { logger: silentKafkaLogger } as any,
  });
  const producer = kafka.producer();
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
 * Polls `admin.listTopics()` until `predicate(topics)` returns true or the
 * timeout elapses. CCloud Kafka propagates metadata asynchronously, so a
 * separate admin client's view of the topic list can lag the broker by a
 * few seconds after a create/delete. Use this to verify state from the
 * test's side-channel without flaking.
 *
 * Resolves when the predicate passes; rejects with the last-seen topic list
 * in the error message if the timeout elapses first.
 */
export async function waitForTopicState(
  admin: KafkaJS.Admin,
  predicate: (topics: string[]) => boolean,
  { timeoutMs = 15_000, intervalMs = 500 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastSeen: string[] = [];
  while (Date.now() < deadline) {
    lastSeen = await admin.listTopics();
    if (predicate(lastSeen)) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `waitForTopicState timed out after ${timeoutMs}ms; last-seen topic count: ${lastSeen.length}`,
  );
}
