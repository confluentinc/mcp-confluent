/**
 * Test-side Kafka admin/producer helpers for Confluent Platform integration
 * tests.
 *
 * Mirrors kafka-admin.ts but connects using SASL_PLAINTEXT (matching the
 * docker-compose.cp-test.yml stack) and reads config from the CP fixture
 * (integration.cp.yaml) via {@linkcode cpIntegrationRuntime}.
 */

import { GlobalConfig, KafkaJS } from "@confluentinc/kafka-javascript";
import { cpIntegrationRuntime } from "@tests/harness/cp-runtime.js";
import { afterAll, beforeAll } from "vitest";

/**
 * Connects a Kafka admin client directly against the local CP stack for
 * test-side resource lifecycle: creating topics in `beforeAll`, verifying
 * topic state after a handler call, and deleting topics in `afterAll`.
 * Callers must `admin.disconnect()` when done.
 */
export async function connectCpTestAdmin(): Promise<KafkaJS.Admin> {
  const admin = newCpKafkaClient("mcp-confluent-cp-it-admin").admin();
  await admin.connect();
  return admin;
}

/**
 * Connects a Kafka producer directly against the local CP stack for
 * test-side seeding: producing messages that a handler test will later
 * consume via the server. Callers must `producer.disconnect()` when done.
 */
export async function connectCpTestProducer(): Promise<KafkaJS.Producer> {
  const producer = newCpKafkaClient("mcp-confluent-cp-it-producer").producer();
  await producer.connect();
  return producer;
}

/**
 * Generates a unique topic name with an `int-cp-` prefix so stale resources
 * from failed CP test runs are easy to identify. Format:
 * `int-cp-<slug>-<timestamp>-<random>`.
 */
export function uniqueCpTopicName(slug: string): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `int-cp-${slug}-${Date.now()}-${random}`;
}

/**
 * Registers `beforeAll`/`afterAll` hooks at the calling describe scope to
 * manage a shared {@link KafkaJS.Admin} client against the CP stack across
 * the tests in that scope. Tests push topic names onto `createdTopics` as
 * they create them; `afterAll` deletes whatever is still tracked before
 * disconnecting.
 *
 * The returned `admin` is a getter (`() => KafkaJS.Admin`) because the
 * underlying client is only assigned inside `beforeAll`.
 */
export function withSharedCpAdminClient(): {
  admin: () => KafkaJS.Admin;
  createdTopics: string[];
} {
  let admin: KafkaJS.Admin;
  const createdTopics: string[] = [];

  beforeAll(async () => {
    admin = await connectCpTestAdmin();
  });

  afterAll(async () => {
    if (createdTopics.length > 0) {
      await admin.deleteTopics({ topics: createdTopics }).catch(() => {
        // teardown-only: a cleanup failure shouldn't fail an already-asserted test
      });
    }
    await admin.disconnect().catch(() => {
      // disconnect race during teardown isn't actionable
    });
  });

  return { admin: () => admin, createdTopics };
}

/**
 * Builds a {@link KafkaJS.Kafka} client configured for the local CP stack.
 * Uses SASL_PLAINTEXT (not SASL_SSL) to match the docker-compose.cp-test.yml
 * listener configuration. Config is read from integration.cp.yaml so the
 * test-side admin and the MCP server always talk to the same broker.
 */
function newCpKafkaClient(clientId: string): KafkaJS.Kafka {
  return new KafkaJS.Kafka({
    ...cpKafkaConfig(clientId),
    kafkaJS: { logger: silentKafkaLogger } as KafkaJS.KafkaConfig,
  });
}

function cpKafkaConfig(clientId: string): GlobalConfig {
  const conn = Object.values(cpIntegrationRuntime().config.connections)[0];
  // The CP fixture is always a direct connection by construction; this guard
  // exists so the union narrowing satisfies TypeScript (ConnectionConfig is
  // now Direct | OAuth).
  if (conn?.type !== "direct") {
    throw new Error(
      "test-side CP kafka admin requires a direct connection in test-fixtures/yaml_configs/integration.cp.yaml",
    );
  }
  if (!conn.kafka?.bootstrap_servers || !conn.kafka.auth) {
    throw new Error(
      "test-side CP kafka admin requires kafka.bootstrap_servers + kafka.auth in test-fixtures/yaml_configs/integration.cp.yaml",
    );
  }
  // Merge extra_properties (which carries security.protocol=SASL_PLAINTEXT
  // for the CP stack) with the base config, so the test-side client matches
  // exactly what the server sends to librdkafka.
  const extraProps = conn.kafka.extra_properties ?? {};
  return {
    "bootstrap.servers": conn.kafka.bootstrap_servers,
    "client.id": clientId,
    "security.protocol": "sasl_plaintext",
    "sasl.mechanisms": "PLAIN",
    "sasl.username": conn.kafka.auth.key,
    "sasl.password": conn.kafka.auth.secret,
    ...extraProps,
  };
}

const silentKafkaLogger: KafkaJS.Logger = {
  namespace: () => silentKafkaLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  setLogLevel: () => {},
};
