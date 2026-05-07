import { SchemaRegistryClient } from "@confluentinc/schemaregistry";
import { integrationRuntime } from "@tests/harness/runtime.js";
import { afterAll, beforeAll } from "vitest";

/**
 * Connects a Schema Registry SDK client directly (not via the MCP server) for test-side resource
 * lifecycle. Built from the same `schema_registry` block the spawned server reads, so the test
 * client and server can never disagree on which registry they're talking to.
 */
export function newTestSrClient(): SchemaRegistryClient {
  const conn = integrationRuntime().config.getSoleDirectConnection();
  if (!conn.schema_registry?.endpoint || !conn.schema_registry.auth) {
    throw new Error(
      "test-side schema registry client requires schema_registry.endpoint + schema_registry.auth in test-fixtures/yaml_configs/integration.yaml",
    );
  }
  const { key, secret } = conn.schema_registry.auth;
  return new SchemaRegistryClient({
    baseURLs: [conn.schema_registry.endpoint],
    basicAuthCredentials: {
      credentialsSource: "USER_INFO",
      userInfo: `${key}:${secret}`,
    },
  });
}

/**
 * Shared {@link SchemaRegistryClient} across the tests in the calling describe scope.
 * `afterAll` permanently deletes every subject pushed onto `createdSubjects` so reruns can reuse
 * the unique-name space (a handler's soft-delete alone would leave the tombstone recoverable).
 */
export function withSharedSrClient(): {
  client: () => SchemaRegistryClient;
  createdSubjects: string[];
} {
  let client: SchemaRegistryClient;
  const createdSubjects: string[] = [];

  beforeAll(() => {
    client = newTestSrClient();
  });

  afterAll(async () => {
    // soft-then-permanent delete is required (SR rejects permanent on a not-yet-soft-deleted
    // subject); 404s are swallowed since the handler may have already done one or both
    await Promise.all(
      createdSubjects.map(async (subject) => {
        await client.deleteSubject(subject, false).catch(() => {});
        await client.deleteSubject(subject, true).catch(() => {});
      }),
    );
  });

  return { client: () => client, createdSubjects };
}

/** Trivial Avro schema body for tests that need to register a subject. */
export const TEST_AVRO_SCHEMA = JSON.stringify({
  type: "record",
  name: "IntegrationTestSchema",
  fields: [{ name: "id", type: "string" }],
});
