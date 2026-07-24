/**
 * Test-side Kafka admin helper for the #543 multi-connection suite.
 *
 * Where kafka-admin.ts and cp-kafka-admin.ts each read their *sole* fixture
 * connection, this builds an admin client from an explicitly-passed
 * {@link DirectConnectionConfig}, so one helper serves both clusters the multi
 * fixture holds. `security.protocol` defaults to `sasl_ssl` (the CCloud shape)
 * and is overridden by the connection's `extra_properties` (the CP broker sets
 * `SASL_PLAINTEXT` there), exactly as the production client resolves it.
 */

import type { GlobalConfig } from "@confluentinc/kafka-javascript";
import { KafkaJS } from "@confluentinc/kafka-javascript";
import { type DirectConnectionConfig } from "@src/config/models.js";

/**
 * Connects a Kafka admin client directly (not via the MCP server) against the
 * cluster described by `conn`, for test-side topic lifecycle and verification.
 * Callers must `admin.disconnect()` when done.
 */
export async function connectAdminForConnection(
  conn: DirectConnectionConfig,
  clientId: string,
): Promise<KafkaJS.Admin> {
  const admin = new KafkaJS.Kafka({
    ...kafkaConfigForConnection(conn, clientId),
    kafkaJS: { logger: silentKafkaLogger } as KafkaJS.KafkaConfig,
  }).admin();
  await admin.connect();
  return admin;
}

/**
 * Builds the librdkafka config for `conn`'s kafka block. Mirrors the protocol
 * resolution the production client uses: a default of `sasl_ssl` overridden by
 * whatever `extra_properties` carries (so the CP broker's `SASL_PLAINTEXT` wins),
 * with `extra_properties` merged last so the test-side client matches exactly
 * what the server sends to librdkafka.
 */
function kafkaConfigForConnection(
  conn: DirectConnectionConfig,
  clientId: string,
): GlobalConfig {
  if (!conn.kafka?.bootstrap_servers || !conn.kafka.auth) {
    throw new Error(
      "test-side multi kafka admin requires kafka.bootstrap_servers + kafka.auth on the connection",
    );
  }
  const extraProps = conn.kafka.extra_properties ?? {};
  return {
    "bootstrap.servers": conn.kafka.bootstrap_servers,
    "client.id": clientId,
    "security.protocol": "sasl_ssl",
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
