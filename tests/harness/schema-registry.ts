import { SchemaRegistryClient } from "@confluentinc/schemaregistry";
import type { paths } from "@src/confluent/openapi-schema.js";
import { createRetryOn429Middleware } from "@tests/harness/retry-on-429.js";
import { integrationRuntime } from "@tests/harness/runtime.js";
import createClient, {
  type Client,
  wrapAsPathBasedClient,
} from "openapi-fetch";
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
 * openapi-fetch client targeting the SR endpoint with HTTP basic auth, for SR REST routes that
 * {@link SchemaRegistryClient} doesn't expose (e.g. `/catalog/v1/...`).
 */
export function newTestSrRestClient(): Client<paths> {
  const conn = integrationRuntime().config.getSoleDirectConnection();
  if (!conn.schema_registry?.endpoint || !conn.schema_registry.auth) {
    throw new Error(
      "test-side schema registry rest client requires schema_registry.endpoint + schema_registry.auth in test-fixtures/yaml_configs/integration.yaml",
    );
  }
  const { key, secret } = conn.schema_registry.auth;
  const basic = Buffer.from(`${key}:${secret}`).toString("base64");
  const client = createClient<paths>({
    baseUrl: conn.schema_registry.endpoint,
    headers: { Authorization: `Basic ${basic}` },
  });
  client.use(createRetryOn429Middleware());
  return client;
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

/**
 * Shared SR REST client + tag-cleanup lifecycle. `afterAll` deletes every tag pushed onto
 * `createdTags` (DELETE `/catalog/v1/types/tagdefs/{tagName}`). 404s are expected when the handler
 * under test already deleted the tag; other non-2xx are logged to surface auth/rate-limit
 * regressions without failing teardown.
 */
export function withSharedCatalogTagsClient(): {
  client: () => Client<paths>;
  createdTags: string[];
} {
  let client: Client<paths>;
  const createdTags: string[] = [];

  beforeAll(() => {
    client = newTestSrRestClient();
  });

  afterAll(async () => {
    const path = wrapAsPathBasedClient(client);
    // allSettled so a single rejection (e.g. network error) don't fail teardown for the others
    await Promise.allSettled(
      createdTags.map(async (tagName) => {
        const { error, response } = await path[
          "/catalog/v1/types/tagdefs/{tagName}"
        ].DELETE({ params: { path: { tagName } } });
        if (error && response.status !== 404) {
          console.error(
            `failed to delete test tag ${tagName} (status ${response.status}): ${JSON.stringify(error)}`,
          );
        }
      }),
    );
  });

  return { client: () => client, createdTags };
}

/** Trivial Avro schema body for tests that need to register a subject. */
export const TEST_AVRO_SCHEMA = JSON.stringify({
  type: "record",
  name: "IntegrationTestSchema",
  fields: [{ name: "id", type: "string" }],
});
