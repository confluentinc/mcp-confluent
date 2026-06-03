import type { paths } from "@src/confluent/openapi-schema.js";
import { createRetryOn429Middleware } from "@tests/harness/retry-on-429.js";
import { integrationRuntime } from "@tests/harness/runtime.js";
import createClient, { type Client } from "openapi-fetch";

export function newTestCloudClient(): Client<paths> {
  const conn = integrationRuntime().config.getSoleDirectConnection();
  if (!conn.confluent_cloud) {
    throw new Error(
      "test-side ccloud client requires confluent_cloud config in test-fixtures/yaml_configs/integration.yaml",
    );
  }
  const { auth, endpoint } = conn.confluent_cloud;
  const basic = Buffer.from(`${auth.key}:${auth.secret}`).toString("base64");
  const client = createClient<paths>({
    baseUrl: endpoint,
    headers: { Authorization: `Basic ${basic}` },
  });
  // smooths transient CCloud rate limiting during full-suite runs
  client.use(createRetryOn429Middleware());
  return client;
}

/**
 * Returns the `kafka.env_id` value from the integration test fixture, for tests that need to
 * address a specific CCloud environment (e.g. as a `READ_ENVIRONMENT` / `LIST_CLUSTERS`
 * argument). Synchronous and YAML-pinned by design: the org-wide `CONFLUENT_CLOUD_API_KEY`
 * sees every env the account has access to, and `GET /org/v2/environments` returns whichever
 * the API happens to list first - which won't necessarily be the one the rest of the harness
 * (kafka cluster, SR endpoint, flink pool) is pinned to. See issue #500 for the context.
 * Throws if `env_id` is missing: the credential gate is at the `confluent_cloud` / `kafka`
 * block level, so without this check the handler would receive `undefined` and produce a
 * confusing downstream error.
 */
export function getTestEnvironmentId(): string {
  const conn = integrationRuntime().config.getSoleDirectConnection();
  if (!conn.kafka?.env_id) {
    throw new Error(
      "test-side env id requires kafka.env_id in test-fixtures/yaml_configs/integration.yaml",
    );
  }
  return conn.kafka.env_id;
}

/**
 * Fetches the logical Schema Registry cluster id (`lsrc-...`) for the integration environment by
 * matching the SR cluster whose {@linkcode srcm.v3.ClusterSpec.http_endpoint} equals the
 * configured `schema_registry.endpoint`, so the test's qualified-name construction stays tied to
 * the same SR cluster the spawned MCP server is talking to.
 */
export async function getSchemaRegistryClusterId(): Promise<string> {
  const conn = integrationRuntime().config.getSoleDirectConnection();
  const envId = conn.kafka?.env_id;
  if (!envId) {
    throw new Error(
      "test-side SR cluster id discovery requires kafka.env_id in test-fixtures/yaml_configs/integration.yaml",
    );
  }
  const srEndpoint = conn.schema_registry?.endpoint;
  if (!srEndpoint) {
    throw new Error(
      "test-side SR cluster id discovery requires schema_registry.endpoint in test-fixtures/yaml_configs/integration.yaml",
    );
  }
  const client = newTestCloudClient();
  const { data, error } = await client.GET("/srcm/v3/clusters", {
    params: { query: { environment: envId } },
  });
  if (error) {
    throw new Error(
      `failed to list sr clusters from ccloud: ${JSON.stringify(error)}`,
    );
  }
  const clusters = data?.data ?? [];
  // strip possible trailing slash
  const normalize = (url: string) => url.replace(/\/+$/, "");
  const wanted = normalize(srEndpoint);
  const matches = clusters.filter(
    (c) => c.spec?.http_endpoint && normalize(c.spec.http_endpoint) === wanted,
  );
  if (matches.length === 0) {
    const seen = clusters
      .map((c) => c.spec?.http_endpoint ?? "<no endpoint>")
      .join(", ");
    throw new Error(
      `no schema registry cluster in environment ${envId} matches configured endpoint ${srEndpoint} (saw: ${seen || "<none>"})`,
    );
  }
  if (matches.length > 1) {
    const ids = matches.map((c) => c.id).join(", ");
    throw new Error(
      `multiple schema registry clusters in environment ${envId} match endpoint ${srEndpoint} (${ids}) - cannot disambiguate`,
    );
  }
  const id = matches[0]?.id;
  if (!id) {
    throw new Error(
      `matched schema registry cluster in environment ${envId} has no id field`,
    );
  }
  return id;
}
